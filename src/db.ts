import { PrismaClient, IntentStatus, Prisma } from "@prisma/client";

export const prisma = new PrismaClient();

export type IntentStatusValue = IntentStatus;

export type CreateIntentInput = {
  agentWallet: string;
  targetContract: string;
  ttlTimestamp: Date;
  maxLimitAtomic: string;
  perBlockRateAtomic: string;
  budgetBlocks: number;
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

// Billing starts at the FIRST in-window block the stream processes (lazily set by the
// dataplane — during a catch-up replay, the intent only starts owing blocks once the
// replay reaches its creation time). CAS on the null so concurrent blocks can't
// double-set it.
export async function setStartBlockNum(id: string, blockNum: number) {
  await prisma.intent.updateMany({ where: { id, startBlockNum: null }, data: { startBlockNum: blockNum } });
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

// How long a SETTLING claim sits before the sweep may re-drive it: long enough for an
// in-flight settle (receipt polling can take ~60s), short enough to retry inside the
// voucher's ttl+120s deadline window.
export const STALE_SETTLING_MS = 2 * 60 * 1000;

// Re-drive claim (4.3): a stale SETTLING intent is owed a retry — the settle call died
// between the claim and the settle (crash, facilitator bounce). This CAS both verifies
// staleness and refreshes updatedAt, so exactly one sweep pass owns the retry and the
// next pass can't re-drive it until it goes stale again. The nonce backstop makes even
// a wrongly-won re-drive safe.
export async function claimStaleSettlement(id: string, staleMs: number = STALE_SETTLING_MS): Promise<boolean> {
  const res = await prisma.intent.updateMany({
    where: { id, status: "SETTLING", updatedAt: { lt: new Date(Date.now() - staleMs) } },
    data: { updatedAt: new Date() },
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
// Window-over check (per-block billing): the intent's window ends at WHICHEVER runs
// out first — the TTL (time) or the block budget (startBlockNum + budgetBlocks).
// Used by the candidates query and the sweep's dispatch alike.
export function windowOver(
  intent: { ttlTimestamp: Date; startBlockNum: number | null; budgetBlocks: number },
  cursorBlock: number | null,
  now = new Date(),
): boolean {
  if (intent.ttlTimestamp < now) return true;
  if (intent.startBlockNum != null && cursorBlock != null && cursorBlock >= intent.startBlockNum + intent.budgetBlocks) return true;
  return false;
}

export async function getSettlementCandidates(now = new Date(), staleSettlingMs: number = STALE_SETTLING_MS) {
  const [active, cursor] = await Promise.all([
    prisma.intent.findMany({ where: { status: { in: ["MONITORING", "SETTLING"] } } }),
    prisma.substreamsCursor.findUnique({ where: { id: "singleton" } }),
  ]);
  const cursorBlock = cursor?.blockNum ?? null;
  const staleBefore = new Date(now.getTime() - staleSettlingMs);
  return active.filter((intent) => {
    if (intent.status === "SETTLING") return intent.updatedAt < staleBefore; // re-drive a dead claim
    if (windowOver(intent, cursorBlock, now)) return true; // TTL or block budget ran out
    return intent.eventsMatched > 0; // lost-trigger recovery
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
