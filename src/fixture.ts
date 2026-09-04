import "dotenv/config";
import { createIntent, storeVerifiedPayment, prisma } from "./db.js";

const MAINNET_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

const agentWallet = process.env.AGENT_WALLET;
if (!agentWallet) throw new Error("AGENT_WALLET is required in .env (demo agent wallet address)");

const intent = await createIntent({
  agentWallet,
  targetContract: MAINNET_USDC,
  ttlTimestamp: new Date(Date.now() + 30 * 60 * 1000),
  maxLimitAtomic: "5000000",
  ratePerEventAtomic: "1858",
  eventCondition: { minAmount: "1000000000" },
  webhookUrl: process.env.FIXTURE_WEBHOOK_URL,
});

const stored = await storeVerifiedPayment(intent.id, `fixture-${Date.now()}`, {
  fixture: true,
});

console.log(
  `fixture intent ${stored.id}\n  status:    ${stored.status}\n  contract:  ${stored.targetContract}\n  condition: ${JSON.stringify(stored.eventCondition)}\n  ttl:       ${stored.ttlTimestamp.toISOString()}\n  ceiling:   ${stored.maxLimitAtomic} · rate: ${stored.ratePerEventAtomic}`,
);
await prisma.$disconnect();
