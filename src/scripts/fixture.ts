/**
 * Dev/demo scaffolding: seeds a fake "paid" intent so the stream matcher has a target
 * before the x402 payment routes (Phase 3) exist. Simulates the exact state Phase 3.3
 * produces after a real verify — a MONITORING intent with a stored (synthetic) voucher.
 * One new intent per run; the TTL expires it after 30 minutes. Run via `npm run fixture`.
 */
import "dotenv/config";
import { createIntent, storeVerifiedPayment, prisma } from "../db.js";

// Data-plane contract (Ethereum mainnet USDC) — NOT the Base Sepolia payment-plane USDC.
const MAINNET_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

const agentWallet = process.env.AGENT_WALLET;
if (!agentWallet) throw new Error("AGENT_WALLET is required in .env (demo agent wallet address)");

const intent = await createIntent({
  agentWallet,
  targetContract: MAINNET_USDC,
  ttlTimestamp: new Date(Date.now() + 30 * 60 * 1000),
  maxLimitAtomic: "5000000", // 5 USDC ceiling (atomic units, 6 decimals) — bounds worst-case spend
  ratePerEventAtomic: "1858", // charged per matching event
  eventCondition: { minAmount: "1000000000" }, // match USDC transfers >= 1,000 (1e9 atomic)
  webhookUrl: process.env.FIXTURE_WEBHOOK_URL,
});

// Synthetic voucher + nonce: marks the intent as paid/verified without touching the
// facilitator — exactly what storeVerifiedPayment does after a real Phase 3.3 verify.
const stored = await storeVerifiedPayment(intent.id, `fixture-${Date.now()}`, {
  fixture: true,
});

console.log(
  `fixture intent ${stored.id}\n  status:    ${stored.status}\n  contract:  ${stored.targetContract}\n  condition: ${JSON.stringify(stored.eventCondition)}\n  ttl:       ${stored.ttlTimestamp.toISOString()}\n  ceiling:   ${stored.maxLimitAtomic} · rate: ${stored.ratePerEventAtomic}`,
);
await prisma.$disconnect();
