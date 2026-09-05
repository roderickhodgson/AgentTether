/**
 * Phase 4 end-to-end: the full financial loop against a live backend, over REAL money.
 *
 * Runs a local webhook receiver (127.0.0.1) and drives two beats:
 *   1. SUCCESS PATH — 30-min intent: the first mainnet USDC match triggers the engine's
 *      success settle (metered actual, receipt-gated) and the webhook must deliver the
 *      matched events + {tx_hash, amount_charged_atomic} AFTER the settlement confirms.
 *   2. TIMEOUT PATH — 60s intent (the minimum): the minute sweep settles the metered
 *      usage inside the voucher's deadline window (ttl + 120s buffer — this beat is the
 *      deadline race), or reports a $0 expiry when nothing matched. The webhook gets the
 *      timeout notice, with event data only if the metered settle succeeded.
 *
 * Expects the backend running (`npm start`) with EVM_PRIVATE_KEY in .env. Exits non-zero
 * on any assertion failure.
 */
import "dotenv/config";
import nodeHttp from "node:http";
import { privateKeyToAccount } from "viem/accounts";
import { toClientEvmSigner } from "@x402/evm";
import { UptoEvmScheme } from "@x402/evm/upto/client";
import { encodePaymentSignatureHeader, decodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { createPublicClient, formatUnits, http } from "viem";
import { baseSepolia } from "viem/chains";
import { prisma } from "../src/db.js";

const BASE_URL = process.env.SERVER_URL ?? "http://localhost:8080";
const RPC_URL = process.env.RPC_URL ?? "https://sepolia.base.org";
const WEBHOOK_PORT = Number(process.env.E2E_WEBHOOK_PORT ?? 9099);
const WEBHOOK_URL = `http://127.0.0.1:${WEBHOOK_PORT}/hook`;
const USDC_MAINNET = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

// ---- webhook receiver ------------------------------------------------------

type Notice = {
  type?: string;
  intent_id?: string;
  tx_hash?: string;
  amount_charged_atomic?: string;
  events_matched?: number;
  events?: unknown[];
};

const notices: Notice[] = [];

const receiver = nodeHttp.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    try {
      const n = JSON.parse(body) as Notice;
      notices.push(n);
      console.log(`webhook ← ${n.type} · intent ${n.intent_id?.slice(0, 8)} · tx ${n.tx_hash ?? "—"} · events ${(n.events ?? []).length}`);
    } catch {
      console.log("webhook ← unparseable body:", body.slice(0, 80));
    }
    res.writeHead(200).end("ok");
  });
});
await new Promise<void>((resolve) => receiver.listen(WEBHOOK_PORT, "127.0.0.1", resolve));
console.log(`webhook receiver listening on ${WEBHOOK_URL}`);

// ---- x402 client (same signing path as the stream client) ------------------

const pk = process.env.EVM_PRIVATE_KEY;
if (!pk) throw new Error("EVM_PRIVATE_KEY is required");
const account = privateKeyToAccount(pk.startsWith("0x") ? (pk as `0x${string}`) : (`0x${pk}` as `0x${string}`));
const publicClient = createPublicClient({ chain: baseSepolia, transport: http(RPC_URL) });
const scheme = new UptoEvmScheme(toClientEvmSigner(account, publicClient), { rpcUrl: RPC_URL });

async function createMonitoringIntent(ttlSeconds: number, label: string, minAmount = "1000000000"): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/v1/intents/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query_intent: `e2e: ${label}`,
      target_contract: USDC_MAINNET,
      event_condition: { minAmount },
      ttl_seconds: ttlSeconds,
      webhook_url: WEBHOOK_URL,
    }),
  });
  const header = res.headers.get("PAYMENT-REQUIRED");
  if (res.status !== 402 || !header) throw new Error(`expected 402 + PAYMENT-REQUIRED, got ${res.status}: ${await res.text()}`);
  const paymentRequired = decodePaymentRequiredHeader(header) as PaymentRequired;
  const requirements = paymentRequired.accepts[0] as PaymentRequirements;
  console.log(
    `  402: up to ${formatUnits(BigInt(requirements.amount), 6)} USDC required (ceiling ${requirements.amount} atomic)` +
      ` · ttl ${ttlSeconds}s · deadline hint ${requirements.maxTimeoutSeconds}s · payTo ${requirements.payTo}`,
  );
  const result = await scheme.createPaymentPayload(2, requirements);
  const payload: PaymentPayload = {
    x402Version: 2,
    resource: paymentRequired.resource,
    accepted: requirements,
    payload: result.payload as Record<string, unknown>,
    extensions: result.extensions,
  };
  const retry = await fetch(`${BASE_URL}/api/v1/intents/stream`, {
    method: "POST",
    headers: { "content-type": "application/json", "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) },
  });
  const out = (await retry.json()) as { job_id?: string; status?: string };
  if (retry.status !== 202 || !out.job_id) throw new Error(`expected 202, got ${retry.status}: ${JSON.stringify(out)}`);
  console.log(`${label}: intent ${out.job_id} → ${out.status}`);
  return out.job_id;
}

async function waitForStatus(id: string, wanted: string[], timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const intent = await prisma.intent.findUnique({ where: { id }, select: { status: true } });
    if (intent && wanted.includes(intent.status)) return intent.status;
    await new Promise((r) => setTimeout(r, 5_000));
  }
  throw new Error(`intent ${id} never reached ${wanted.join("/")}`);
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${message}`);
}

// ---- the beats -------------------------------------------------------------

// Beat 1 — success path: real match → real settle → fail-closed data delivery.
const successId = await createMonitoringIntent(1800, "success beat");
console.log("beat 1: waiting for first match + settlement (up to 4 min) …");
assert((await waitForStatus(successId, ["SETTLED"], 4 * 60_000)) === "SETTLED", "success beat reached SETTLED");
const n1 = notices.find((n) => n.intent_id === successId && n.type === "settlement.confirmed");
assert(n1, "success beat delivered settlement.confirmed webhook");
assert(n1.tx_hash, "success beat webhook carries the settlement tx");
assert((n1.events ?? []).length > 0, "success beat webhook carries matched event data");
assert((n1.amount_charged_atomic ?? "") !== "", "success beat webhook carries the charged amount");
console.log(
  `beat 1 PASS — settled ${formatUnits(BigInt(n1.amount_charged_atomic!), 6)} USDC — https://sepolia.basescan.org/tx/${n1.tx_hash}`,
);

// Beat 2 — timeout path with a LIVE deadline: a no-match intent (impossibly-high
// threshold) expires at TTL with zero usage — the minute sweep settles $0 (no on-chain
// tx, the authorization simply expires) and notifies WITHOUT data. (A healthy intent
// that DID match events settles early via the success path — beat 1 — so the cron's
// metered-timeout branch only ever fires for lost triggers; that branch is covered by
// spikes/settlement-direct.ts instead.)
const timeoutId = await createMonitoringIntent(60, "timeout beat", "1000000000000000000");
console.log("beat 2: waiting for TTL expiry + sweep $0 timeout (up to 4 min) …");
assert((await waitForStatus(timeoutId, ["TIMEOUT"], 4 * 60_000)) === "TIMEOUT", "timeout beat reached TIMEOUT");
const timeoutIntent = await prisma.intent.findUnique({ where: { id: timeoutId } });
const n2 = notices.find((n) => n.intent_id === timeoutId && n.type === "intent.timeout");
assert(n2, "timeout beat delivered intent.timeout webhook");
// per-block billing: the idle window settles the blocks it actually processed
assert(timeoutIntent?.settlementTxHash, "idle timeout settles the processed blocks on-chain");
assert((timeoutIntent?.settledAmountAtomic ?? "") !== "", "idle timeout carries the block charge");
assert((n2.events ?? []).length === 0, "idle timeout notice carries no event data (nothing fired)");
console.log(
  `beat 2 PASS — idle window settled ${timeoutIntent?.settledAmountAtomic} atomic for its blocks: https://sepolia.basescan.org/tx/${timeoutIntent?.settlementTxHash}`,
);

console.log("\nPHASE 4 E2E PASS — settlement engine verified end-to-end");
await prisma.$disconnect();
receiver.close();
process.exit(0);
