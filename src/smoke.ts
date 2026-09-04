import {
  createIntent,
  storeVerifiedPayment,
  incrementEventsMatched,
  getIntentByPaymentNonce,
  getExpiredMonitoringIntents,
  updateIntentStatus,
  prisma,
} from "./db.js";

const agentWallet = process.env.AGENT_WALLET;
if (!agentWallet) throw new Error("AGENT_WALLET is required in .env (demo agent wallet address)");

const intent = await createIntent({
  agentWallet,
  targetContract: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  ttlTimestamp: new Date(Date.now() - 1000),
  maxLimitAtomic: "5000000",
  ratePerEventAtomic: "1858",
  eventCondition: { minAmount: "100000000000" },
});
console.log("created:", intent.status, "| nonce null:", intent.paymentNonce === null);

await storeVerifiedPayment(intent.id, "0xspike-nonce-test", { spike: true });
await incrementEventsMatched(intent.id);

const byNonce = await getIntentByPaymentNonce("0xspike-nonce-test");
console.log(
  "by nonce:",
  byNonce?.status,
  "| eventsMatched:",
  byNonce?.eventsMatched,
  "| payload stored:",
  JSON.stringify(byNonce?.paymentPayload),
);

const expired = await getExpiredMonitoringIntents();
console.log(
  "expired-monitoring count:",
  expired.length,
  "(includes our intent:",
  expired.some((i) => i.id === intent.id),
  ")",
);

await updateIntentStatus(intent.id, "SETTLED");
console.log("final status:", (await prisma.intent.findUnique({ where: { id: intent.id } }))?.status);

await prisma.intent.delete({ where: { id: intent.id } });
console.log("cleaned up. CRUD OK.");
process.exit(0);
