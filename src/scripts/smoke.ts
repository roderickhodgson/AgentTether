import {
  createIntent,
  storeVerifiedPayment,
  incrementEventsMatched,
  getIntentByPaymentNonce,
  getExpiredMonitoringIntents,
  updateIntentStatus,
  claimForSettlement,
  markSettled,
  markTimeout,
  getSettlementCandidates,
  getCursor,
  saveCursor,
  clearCursor,
  meterAndCommit,
  prisma,
} from "../db.js";

const agentWallet = process.env.AGENT_WALLET;
if (!agentWallet) throw new Error("AGENT_WALLET is required in .env (demo agent wallet address)");

const intent = await createIntent({
  agentWallet,
  targetContract: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  ttlTimestamp: new Date(Date.now() - 1000),
  maxLimitAtomic: "5000000",
  perBlockRateAtomic: "100",
  budgetBlocks: 50000,
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

// CAS claim: first mover wins, second caller no-ops (4.2's operational guard)
const firstClaim = await claimForSettlement(intent.id);
const secondClaim = await claimForSettlement(intent.id);
console.log("cas claim:", firstClaim, "/", secondClaim, "(expect true/false)");

await markSettled(intent.id, "0xsmoke-tx-hash", "1858");
const settled = await prisma.intent.findUnique({ where: { id: intent.id } });
console.log("settled:", settled?.status, "| tx:", settled?.settlementTxHash, "| amount:", settled?.settledAmountAtomic);

// timeout path + recovery-set membership, on a throwaway second intent
const timeoutIntent = await createIntent({
  agentWallet,
  targetContract: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  ttlTimestamp: new Date(Date.now() - 1000),
  maxLimitAtomic: "5000000",
  perBlockRateAtomic: "100",
  budgetBlocks: 50000,
  eventCondition: { minAmount: "100000000000" },
});
await storeVerifiedPayment(timeoutIntent.id, "0xsmoke-nonce-timeout", { spike: true });
// The cursor is SHARED state — a live stream resumes from it. Save it, run the
// meterAndCommit lifecycle, then restore exactly what was there (delete if none) so
// the smoke test can never poison the stream with a synthetic cursor value.
const cursorBefore = await getCursor();
await meterAndCommit(
  new Map([[timeoutIntent.id, 1]]),
  [{
    intentId: timeoutIntent.id,
    chain: "ethereum-mainnet",
    block: 123,
    blockTimestamp: new Date().toISOString(),
    txHash: "0xsmoke-event-tx",
    logIndex: 0,
    from: "0xfrom",
    to: "0xto",
    amount: "100000000000",
  }],
  "0xsmoke-cursor",
  123,
);
if (cursorBefore) await saveCursor(cursorBefore.cursor, cursorBefore.blockNum);
else await clearCursor();
const candidates = await getSettlementCandidates();
console.log(
  "recovery set:",
  candidates.map((i) => `${i.id.slice(0, 8)}:${i.status}:${i.eventsMatched}`),
);
await markTimeout(timeoutIntent.id);
const timedOut = await prisma.intent.findUnique({ where: { id: timeoutIntent.id } });
console.log("timeout:", timedOut?.status, "| no tx:", timedOut?.settlementTxHash === null);
await prisma.intent.delete({ where: { id: timeoutIntent.id } });

await updateIntentStatus(intent.id, "SETTLED");
console.log("final status:", (await prisma.intent.findUnique({ where: { id: intent.id } }))?.status);

await prisma.intent.delete({ where: { id: intent.id } });
console.log("cleaned up. CRUD OK.");
process.exit(0);
