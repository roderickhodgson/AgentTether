import { PrismaClient, IntentStatus, Prisma } from "@prisma/client";

export const prisma = new PrismaClient();

export type IntentStatusValue = IntentStatus;

export type CreateIntentInput = {
  agentWallet: string;
  targetContract: string;
  ttlTimestamp: Date;
  maxLimitAtomic: string;
  ratePerEventAtomic: string;
  eventCondition: Prisma.InputJsonValue;
  webhookUrl?: string;
};

export async function createIntent(input: CreateIntentInput) {
  return prisma.intent.create({
    data: { ...input, status: "PENDING_PAYMENT" },
  });
}

export async function getIntent(id: string) {
  return prisma.intent.findUnique({ where: { id } });
}

export async function getIntentByPaymentNonce(nonce: string) {
  return prisma.intent.findUnique({ where: { paymentNonce: nonce } });
}

export async function storeVerifiedPayment(
  id: string,
  paymentNonce: string,
  paymentPayload: Prisma.InputJsonValue,
  agentWallet?: string,
) {
  return prisma.intent.update({
    where: { id },
    data: {
      paymentNonce,
      paymentPayload,
      status: "MONITORING",
      ...(agentWallet ? { agentWallet } : {}),
    },
  });
}

export async function updateIntentStatus(id: string, status: IntentStatus) {
  return prisma.intent.update({ where: { id }, data: { status } });
}

export async function incrementEventsMatched(id: string, by = 1) {
  return prisma.intent.update({
    where: { id },
    data: { eventsMatched: { increment: by } },
  });
}

// Atomic per-block metering: increments every intent in the map, appends the matched
// transfers (bounded — see MAX_PERSISTED_EVENTS) for the webhook payload, and advances
// the stream cursor in ONE transaction. A crash mid-block rolls all of it back, so the
// restart replays the block cleanly — the cursor never advances past un-metered matches.

// Webhook payloads carry the first 50 matched transfers per intent; the counter keeps
// counting past the cap and the settlement notice reports the truncation.
export const MAX_PERSISTED_EVENTS = 50;

export type MatchEventInput = {
  intentId: string;
  chain: string;
  block: number | bigint;
  blockTimestamp: string;
  txHash: string;
  logIndex: number;
  from: string;
  to: string;
  amount: string;
};

export type PersistedMatchedEvent = Omit<MatchEventInput, "intentId" | "block"> & { block: number };

export async function meterAndCommit(
  byIntent: Map<string, number>,
  events: MatchEventInput[],
  cursor: string,
  blockNum: number,
) {
  return prisma.$transaction(async (tx) => {
    const totals = new Map<string, number>();
    for (const [intentId, count] of byIntent) {
      const fresh = events
        .filter((e) => e.intentId === intentId)
        .map(({ intentId: _drop, ...record }) => ({ ...record, block: Number(record.block) }) as PersistedMatchedEvent);
      const row = await tx.intent.findUnique({
        where: { id: intentId },
        select: { eventsMatched: true, matchedEvents: true },
      });
      if (!row) continue; // intent deleted mid-block — metering drops out, cursor still advances
      const prior = Array.isArray(row.matchedEvents) ? (row.matchedEvents as PersistedMatchedEvent[]) : [];
      const merged = prior.length >= MAX_PERSISTED_EVENTS ? prior : [...prior, ...fresh].slice(0, MAX_PERSISTED_EVENTS);
      const updated = await tx.intent.update({
        where: { id: intentId },
        data: { eventsMatched: { increment: count }, matchedEvents: merged },
      });
      totals.set(intentId, updated.eventsMatched);
    }
    await tx.substreamsCursor.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", cursor, blockNum },
      update: { cursor, blockNum },
    });
    return totals;
  });
}

export async function getMonitoringIntents() {
  return prisma.intent.findMany({ where: { status: "MONITORING" } });
}

export async function getExpiredMonitoringIntents(now = new Date()) {
  return prisma.intent.findMany({
    where: { status: "MONITORING", ttlTimestamp: { lt: now } },
  });
}

// CAS claim (4.2's operational guard): exactly one concurrent invoker wins the
// MONITORING → SETTLING transition; losers get false and no-op. The intent also drops
// out of matching once non-MONITORING, so no further triggers fire.
export async function claimForSettlement(id: string): Promise<boolean> {
  const res = await prisma.intent.updateMany({
    where: { id, status: "MONITORING" },
    data: { status: "SETTLING" },
  });
  return res.count === 1;
}

export async function markSettled(id: string, settlementTxHash: string, settledAmountAtomic: string) {
  return prisma.intent.update({
    where: { id },
    data: { status: "SETTLED", settlementTxHash, settledAmountAtomic },
  });
}

export async function markSettleFailed(id: string) {
  return prisma.intent.update({ where: { id }, data: { status: "SETTLE_FAILED" } });
}

export async function markTimeout(id: string, settledAmountAtomic?: string, settlementTxHash?: string) {
  return prisma.intent.update({
    where: { id },
    data: {
      status: "TIMEOUT",
      ...(settledAmountAtomic ? { settledAmountAtomic } : {}),
      ...(settlementTxHash ? { settlementTxHash } : {}),
    },
  });
}

// 4.3 recovery set — three ways an intent can be owed settlement work:
//  - MONITORING past TTL → timeout settlement (the cron's bread and butter)
//  - MONITORING with metered events → engine trigger lost to a crash between the atomic
//    metering commit and the post-commit trigger (the startup sweep's target)
//  - stale SETTLING → crash between the CAS claim and the settle call (the nonce is not
//    consumed until settle succeeds, so a re-drive is safe; if settle DID succeed but the
//    response was lost, the re-drive's nonce-consumed rejection is logged for the runbook,
//    never auto-flipped to SETTLE_FAILED — money may have moved).
export async function getSettlementCandidates(now = new Date(), staleSettlingMs = 2 * 60 * 1000) {
  return prisma.intent.findMany({
    where: {
      OR: [
        { status: "MONITORING", ttlTimestamp: { lt: now } },
        { status: "MONITORING", eventsMatched: { gt: 0 } },
        { status: "SETTLING", updatedAt: { lt: new Date(now.getTime() - staleSettlingMs) } },
      ],
    },
  });
}

export async function getCursor() {
  return prisma.substreamsCursor.findUnique({ where: { id: "singleton" } });
}

export async function saveCursor(cursor: string, blockNum: number) {
  return prisma.substreamsCursor.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", cursor, blockNum },
    update: { cursor, blockNum },
  });
}

export async function clearCursor() {
  await prisma.substreamsCursor.deleteMany({});
}
