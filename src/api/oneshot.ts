/**
 * Phase 3.4 — the oneshot pull endpoint: flat fee, immediate response, no TTL, no
 * metering. The contrasting product to the stream: the client POSTs a query, pays the
 * quoted flat fee through the STANDARD x402 middleware flow (auto-settle after the
 * handler responds — the /stream route deliberately bypasses this; /oneshot may use
 * it), and gets the lookback results over the processed-block capture in the response.
 *
 * Rails are equal citizens: each rail is one PaymentOption in `accepts` with its own
 * network, payTo, price and (implicitly, via the facilitator client array) its own
 * facilitator. The Hedera rail activates only once HEDERA_PAY_TO is configured — until
 * then the route advertises Base only, so an unconfigured rail can't 402-bait clients.
 */
import type { Express, Request, Response } from "express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { paymentMiddlewareFromConfig, type SchemeRegistration } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import { lookbackTransfers } from "../db.js";
import { logger } from "../logger.js";
import {
  FACILITATOR_URL,
  HEDERA_FACILITATOR_URL,
  NETWORK,
  PAY_TO_ADDRESS,
  USDC_ADDRESS,
} from "../payments/facilitator.js";
import {
  oneshotContracts,
  oneshotLookbackBlocksMax,
  oneshotPriceBaseAtomic,
  oneshotPriceHederaTinybars,
} from "../payments/pricing.js";

const ONESHOT_PATH = "/api/v1/intents/oneshot";
const MAX_RESULT_LIMIT = 500;

// HEDERA_PAY_TO accepts either form: a bare Hedera entity id (0.0.x — used as-is) or an
// EVM address (0x… — resolved to its entity id via the testnet mirror node, since the
// scheme/facilitator validate receivers against the entity-id form). Returns null while
// the account doesn't exist yet (rail not advertised).
async function resolveHederaPayTo(): Promise<string | null> {
  const payTo = process.env.HEDERA_PAY_TO ?? "";
  if (!payTo) return null;
  if (/^\d+\.\d+\.\d+$/.test(payTo)) return payTo;
  try {
    const res = await fetch(`https://testnet.mirrornode.hedera.com/api/v1/accounts/${payTo}`);
    if (res.status === 404) {
      logger.warn({ payTo }, "HEDERA_PAY_TO account does not exist on hedera:testnet yet — hedera rail not advertised");
      return null;
    }
    const account = (await res.json()) as { account?: string };
    if (!account.account) return null;
    logger.info({ from: payTo, to: account.account }, "resolved HEDERA_PAY_TO to its Hedera entity id");
    return account.account;
  } catch (e) {
    logger.error({ err: e instanceof Error ? e.message : e, payTo }, "mirror lookup for HEDERA_PAY_TO failed — hedera rail not advertised");
    return null;
  }
}

export async function mountOneshot(app: Express): Promise<void> {
  if (!PAY_TO_ADDRESS) {
    logger.warn("PAY_TO_ADDRESS unset — /oneshot not mounted");
    return;
  }

  const hederaPayTo = await resolveHederaPayTo();
  const rails: unknown[] = [
    {
      scheme: "exact",
      payTo: PAY_TO_ADDRESS,
      price: {
        asset: USDC_ADDRESS,
        amount: oneshotPriceBaseAtomic().toString(),
        extra: { name: "USDC", version: "2" },
      },
      network: NETWORK,
      maxTimeoutSeconds: 60,
    },
  ];
  // One facilitator client per rail; the resource server picks the first client whose
  // /supported advertises the payment's network (discovered at startup — never hardcode
  // capabilities). Order encodes the bounty's routing: Blocky402 first makes it the
  // hedera:testnet primary; it doesn't advertise eip155:84532, so Base falls through to
  // the default facilitator — and the default remains the degraded-mode hedera fallback
  // (risk #4) whenever Blocky402 is skipped/unavailable.
  const facilitators = hederaPayTo
    ? [new HTTPFacilitatorClient({ url: HEDERA_FACILITATOR_URL }), new HTTPFacilitatorClient({ url: FACILITATOR_URL })]
    : [new HTTPFacilitatorClient({ url: FACILITATOR_URL })];
  const schemes: SchemeRegistration[] = [{ network: NETWORK, server: new ExactEvmScheme() }];
  if (hederaPayTo) {
    rails.push({
      scheme: "exact",
      payTo: hederaPayTo,
      price: {
        asset: "0.0.0", // HBAR_ASSET_ID — HBAR in tinybars (8 decimals)
        amount: oneshotPriceHederaTinybars().toString(),
      },
      network: "hedera:testnet",
      maxTimeoutSeconds: 60,
    });
    schemes.push({ network: "hedera:testnet", server: new ExactHederaScheme() });
  }
  logger.info(
    { rails: rails.map((r) => (r as { network: string }).network) },
    "oneshot payment rails",
  );

  const oneshotPayment = paymentMiddlewareFromConfig(
    {
      [ONESHOT_PATH]: {
        accepts: rails as never,
        description: "Oneshot ERC-20 transfer lookup over the processed-block capture",
        mimeType: "application/json",
        unpaidResponseBody: () => ({
          contentType: "application/json",
          body: { error: "payment_required", endpoint: ONESHOT_PATH },
        }),
      },
    },
    facilitators,
    schemes,
  );

  app.use(oneshotPayment);
  app.post(ONESHOT_PATH, handler);
  logger.info({ path: ONESHOT_PATH }, "oneshot endpoint mounted");
}

type OneshotBody = {
  target_contract?: string;
  min_amount_atomic?: string | number;
  lookback_blocks?: number;
  limit?: number;
};

export type OneshotQuery = {
  contract: string;
  lookback: number;
  limit: number;
  minAmount?: bigint;
};

// Pure body validation — clamps lookback/limit into server-owned bounds, lowercases and
// allowlist-checks the contract, parses the optional min-amount. The handler stays thin.
export function parseOneshotQuery(
  body: OneshotBody | undefined,
  opts: { contracts: string[]; maxLookback: number; maxLimit: number },
): { ok: true; query: OneshotQuery } | { ok: false; status: number; error: string; supported?: string[] } {
  const b = body ?? {};
  const contract = (b.target_contract ?? "").toLowerCase();
  if (!opts.contracts.includes(contract)) {
    return { ok: false, status: 400, error: "unsupported_contract", supported: opts.contracts };
  }
  const requested = Number(b.lookback_blocks ?? opts.maxLookback);
  const lookback = Number.isFinite(requested)
    ? Math.min(opts.maxLookback, Math.max(1, Math.floor(requested)))
    : opts.maxLookback;
  const rawLimit = Number(b.limit ?? 100);
  const limit = Number.isFinite(rawLimit) ? Math.min(opts.maxLimit, Math.max(1, Math.floor(rawLimit))) : 100;
  let minAmount: bigint | undefined;
  if (b.min_amount_atomic !== undefined) {
    try {
      minAmount = BigInt(b.min_amount_atomic);
    } catch {
      return { ok: false, status: 400, error: "invalid_min_amount_atomic" };
    }
    if (minAmount < 0n) return { ok: false, status: 400, error: "invalid_min_amount_atomic" };
  }
  return { ok: true, query: { contract, lookback, limit, minAmount } };
}

async function handler(req: Request, res: Response): Promise<void> {
  const parsed = parseOneshotQuery(req.body as OneshotBody | undefined, {
    contracts: oneshotContracts(),
    maxLookback: oneshotLookbackBlocksMax(),
    maxLimit: MAX_RESULT_LIMIT,
  });
  if (!parsed.ok) {
    res.status(parsed.status).json(
      parsed.supported ? { error: parsed.error, supported: parsed.supported } : { error: parsed.error },
    );
    return;
  }
  const { contract, lookback, limit, minAmount } = parsed.query;

  const result = await lookbackTransfers({ contract, minAmountAtomic: minAmount, maxLookbackBlocks: lookback, limit });
  if (!result.head) {
    res.status(503).json({ error: "no_stream_cursor", detail: "the data plane has not processed any blocks yet" });
    return;
  }

  res.json({
    window: result.window,
    head_block: result.head.blockNum,
    transfers: result.transfers.map((t) => ({
      chain: t.chain,
      block_num: t.blockNum,
      block_timestamp: t.blockTimestamp.toISOString(),
      tx_hash: t.txHash,
      log_index: t.logIndex,
      contract: t.contract,
      from: t.from,
      to: t.to,
      amount_atomic: t.amount.toString(),
    })),
  });
}
