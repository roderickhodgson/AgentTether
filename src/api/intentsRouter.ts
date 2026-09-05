/**
 * x402 API layer for metered stream intents (Phase 3.2/3.3).
 *
 * POST /api/v1/intents/stream is a single route with two phases:
 *  - no PAYMENT-SIGNATURE header → create a PENDING_PAYMENT intent and answer 402 with
 *    `upto` PaymentRequirements (the ceiling the agent must sign). No settlement here.
 *  - with PAYMENT-SIGNATURE header → decode the voucher, correlate it to the intent
 *    (resource url + permit nonce), verify against the facilitator, enforce the
 *    deadline ≥ ttl + buffer rule, store the verified payload and return 202.
 *
 * Settlement is DEFERRED by design (Phase 4): this route must never call /settle —
 * standard paymentMiddleware auto-settles after the handler responds, which is why the
 * route is hand-rolled on the @x402/core header codecs instead.
 */
import { Router } from "express";
import { encodePaymentRequiredHeader, decodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import type { Prisma } from "@prisma/client";
import type { Request, Response } from "express";
import { createIntent, getIntent, getIntentByPaymentNonce, storeVerifiedPayment } from "../db.js";
import { discoverUpto, facilitator, NETWORK, USDC_ADDRESS, PAY_TO_ADDRESS } from "../payments/facilitator.js";
import { logger } from "../logger.js";

// Permit2 deadlines must outlive the monitoring window: cron sweeps run every minute
// (4.3) and settlement itself takes time, so require the voucher to be valid for the
// whole TTL plus this buffer.
const DEADLINE_BUFFER_S = 120;
// Heuristic for ceiling estimation when the agent doesn't pass max_limit_atomic:
// expected matching events per minute on the watched contract (mainnet USDC at the
// demo threshold runs ~4–10/min; 5 is the conservative middle).
const EST_MATCHES_PER_MIN = 5;
const DEFAULT_RATE_PER_EVENT = "1858";
const MIN_TTL_S = 60;
const MAX_TTL_S = 86_400;

type StreamIntentBody = {
  query_intent?: string;
  target_contract?: string;
  event_condition?: { minAmount?: string };
  ttl_seconds?: number;
  webhook_url?: string;
  rate_per_event_atomic?: string;
  max_limit_atomic?: string;
};

const isHexAddress = (v: string) => /^0x[0-9a-fA-F]{40}$/.test(v);
const isAtomicString = (v: string | undefined) => typeof v === "string" && /^\d+$/.test(v);

function resourceUrl(req: Request, intentId: string): string {
  const host = req.get("host") ?? `localhost:${process.env.PORT ?? 8080}`;
  return `${req.protocol}://${host}/api/v1/intents/stream?intent=${intentId}`;
}

function intentResource(req: Request, intentId: string, description: string): PaymentRequired["resource"] {
  return { url: resourceUrl(req, intentId), description, mimeType: "application/json" };
}

function paymentRequiredResponse(res: Response, paymentRequired: PaymentRequired, reason?: string) {
  const body = reason ? { ...paymentRequired, error: reason } : paymentRequired;
  res.set("PAYMENT-REQUIRED", encodePaymentRequiredHeader(paymentRequired));
  res.status(402).json(body);
}

// Requirements are authoritative from OUR side: the client must sign exactly this
// ceiling, payTo, asset and facilitator binding. `maxTimeoutSeconds` mirrors what was
// advertised in the 402 (ttl + buffer) — it is the client's Permit2 deadline hint.
async function streamRequirements(body: StreamIntentBody) {
  const ttl = Math.min(MAX_TTL_S, Math.max(MIN_TTL_S, Math.floor(Number(body.ttl_seconds ?? 0))));
  const rate = isAtomicString(body.rate_per_event_atomic) ? body.rate_per_event_atomic! : DEFAULT_RATE_PER_EVENT;
  const maxLimit = isAtomicString(body.max_limit_atomic)
    ? body.max_limit_atomic!
    : (BigInt(rate) * BigInt(Math.max(1, Math.ceil(ttl / 60)) * EST_MATCHES_PER_MIN)).toString();
  const { facilitatorAddress } = await discoverUpto();

  const requirements: PaymentRequirements = {
    scheme: "upto",
    network: NETWORK,
    asset: USDC_ADDRESS,
    amount: maxLimit,
    payTo: PAY_TO_ADDRESS,
    maxTimeoutSeconds: ttl + DEADLINE_BUFFER_S,
    extra: { name: "USDC", version: "2", facilitatorAddress },
  };
  return { requirements, ttl, maxLimit };
}

function advertisedMaxTimeoutSeconds(ttlSeconds: number): number {
  return ttlSeconds + DEADLINE_BUFFER_S;
}

export const intentsRouter = Router();

intentsRouter.post("/api/v1/intents/stream", async (req: Request, res: Response) => {
  if (!PAY_TO_ADDRESS) {
    res.status(503).json({ error: "PAY_TO_ADDRESS is not configured in .env (payment receiver wallet)" });
    return;
  }

  const signature = req.header("PAYMENT-SIGNATURE");
  if (!signature) {
    await createIntentHandler(req, res);
    return;
  }
  await verifySignedPayment(req, res, signature);
});

// Phase 1 of the flow (3.2): create the intent, advertise the payment requirements.
async function createIntentHandler(req: Request, res: Response) {
  const body = (req.body ?? {}) as StreamIntentBody;
  const problems: string[] = [];
  if (!body.query_intent || typeof body.query_intent !== "string") problems.push("query_intent (string) is required");
  if (!body.target_contract || !isHexAddress(body.target_contract)) problems.push("target_contract (0x address) is required");
  if (!body.event_condition || !isAtomicString(body.event_condition.minAmount)) {
    problems.push("event_condition.minAmount (atomic-unit string) is required");
  }
  if (!Number.isFinite(Number(body.ttl_seconds)) || Number(body.ttl_seconds) < MIN_TTL_S) {
    problems.push(`ttl_seconds (number ≥ ${MIN_TTL_S}) is required`);
  }
  if (body.webhook_url && !/^https:\/\//.test(body.webhook_url)) {
    problems.push("webhook_url must be https (see risk #8 SSRF note)");
  }
  if (problems.length > 0) {
    res.status(400).json({ error: "invalid intent", problems });
    return;
  }

  const { requirements, ttl, maxLimit } = await streamRequirements(body);
  const intent = await createIntent({
    agentWallet: "unknown",
    targetContract: body.target_contract!,
    ttlTimestamp: new Date(Date.now() + ttl * 1000),
    maxLimitAtomic: maxLimit,
    ratePerEventAtomic: body.rate_per_event_atomic ?? DEFAULT_RATE_PER_EVENT,
    eventCondition: body.event_condition as { minAmount: string },
    webhookUrl: body.webhook_url,
  });

  const paymentRequired: PaymentRequired = {
    x402Version: 2,
    resource: intentResource(req, intent.id, body.query_intent!),
    accepts: [requirements],
  };
  paymentRequiredResponse(res, paymentRequired);
  logger.info({ intent: intent.id, maxLimit, ttl }, "intent created — 402 issued, awaiting signed voucher");
}

// Phase 2 of the flow (3.3): decode the voucher, correlate, verify, store — no settle.
async function verifySignedPayment(req: Request, res: Response, signature: string) {
  let payload: PaymentPayload;
  try {
    payload = decodePaymentSignatureHeader(signature);
  } catch {
    res.status(400).json({ error: "PAYMENT-SIGNATURE header is not a decodable PaymentPayload" });
    return;
  }

  const intentId = new URL(payload.resource?.url ?? "").searchParams.get("intent");
  const permit2 = (payload.payload as { permit2Authorization?: { nonce?: string; deadline?: string; from?: string } } | undefined)
    ?.permit2Authorization;
  if (!intentId || !permit2?.nonce) {
    res.status(400).json({ error: "payment payload is missing the resource.url intent reference or the permit2 nonce" });
    return;
  }

  // Nonce idempotency: one voucher settles exactly one intent. A replayed payment for
  // the same intent is answered idempotently; the same voucher pointed at a different
  // intent is rejected.
  const existing = await getIntentByPaymentNonce(permit2.nonce);
  if (existing) {
    if (existing.id === intentId && existing.status !== "PENDING_PAYMENT") {
      res.status(202).json({ job_id: existing.id, status: existing.status, idempotent: true });
      return;
    }
    res.status(409).json({ error: "this voucher nonce is already bound to another intent" });
    return;
  }

  const intent = await getIntent(intentId);
  if (!intent || intent.status !== "PENDING_PAYMENT") {
    res.status(404).json({ error: "unknown or already-processed intent" });
    return;
  }

  // Verify against OUR stored requirements (the ceiling this intent advertised).
  const { facilitatorAddress } = await discoverUpto();
  const advertisedTtlS = Math.max(
    MIN_TTL_S,
    Math.floor((intent.ttlTimestamp.getTime() - intent.createdAt.getTime()) / 1000),
  );
  const requirements: PaymentRequirements = {
    scheme: "upto",
    network: NETWORK,
    asset: USDC_ADDRESS,
    amount: intent.maxLimitAtomic,
    payTo: PAY_TO_ADDRESS,
    maxTimeoutSeconds: advertisedMaxTimeoutSeconds(advertisedTtlS),
    extra: { name: "USDC", version: "2", facilitatorAddress },
  };
  const paymentRequired: PaymentRequired = {
    x402Version: 2,
    resource: intentResource(req, intent.id, "conditional monitoring intent"),
    accepts: [requirements],
  };

  const verification = await facilitator.verify(payload, requirements);
  if (!verification.isValid) {
    logger.warn({ intent: intentId, invalidReason: verification.invalidReason }, "payment verification failed");
    paymentRequiredResponse(res, paymentRequired, verification.invalidReason ?? "payment_invalid");
    return;
  }

  // Deadline guard (3.3): the voucher must still be valid at settlement time —
  // ttl + settlement buffer, not merely at verify time.
  const deadline = Number(permit2.deadline ?? 0);
  const requiredDeadlineS = Math.floor(intent.ttlTimestamp.getTime() / 1000) + DEADLINE_BUFFER_S;
  if (!deadline || deadline < requiredDeadlineS) {
    paymentRequiredResponse(
      res,
      paymentRequired,
      `permit deadline must be ≥ ttl + ${DEADLINE_BUFFER_S}s (required ${requiredDeadlineS}, got ${deadline})`,
    );
    return;
  }

  const payer = verification.payer ?? permit2.from ?? "unknown";
  const stored = await storeVerifiedPayment(
    intent.id,
    permit2.nonce,
    payload as unknown as Prisma.InputJsonValue,
    payer,
  );

  // DEFERRED SETTLEMENT: no /settle here by design (3.1) — Phase 4's engine settles
  // from the stored voucher when the monitoring window ends.
  logger.info(
    { intent: stored.id, payer, eventsMatched: stored.eventsMatched },
    "voucher verified and stored — intent is MONITORING (settlement deferred)",
  );
  res.status(202).json({
    job_id: stored.id,
    status: stored.status,
    agent_wallet: payer,
    events_matched: stored.eventsMatched,
    ttl_timestamp: stored.ttlTimestamp.toISOString(),
  });
}
