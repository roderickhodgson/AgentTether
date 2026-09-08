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
    data: {
      ...input,
      status: "PENDING_PAYMENT",
      lifecycle: [{ step: "requested", at: new Date().toISOString() }] as unknown as Prisma.InputJsonValue,
    },
  });
}

// Lifecycle append (the flow-chart data): one entry per transition. Safe under the
// single-writer rule (read-modify-write, no CAS needed); capped so a chatty agent's
// annotations can't balloon the row.
export const MAX_LIFECYCLE_STEPS = 50;

export type LifecycleStep = { step: string; at: string; detail?: Record<string, unknown> };

export async function appendLifecycle(id: string, step: string, detail?: Record<string, unknown>) {
  const entry: LifecycleStep = { step, at: new Date().toISOString(), ...(detail ? { detail } : {}) };
  const row = await prisma.intent.findUnique({ where: { id }, select: { lifecycle: true } });
  if (!row) return;
  const prior = (Array.isArray(row.lifecycle) ? row.lifecycle : []) as LifecycleStep[];
  await prisma.intent.update({
    where: { id },
    data: { lifecycle: [...prior, entry].slice(-MAX_LIFECYCLE_STEPS) as unknown as Prisma.InputJsonValue },
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
  const res = await prisma.intent.update({
    where: { id },
    data: {
      paymentNonce,
      paymentPayload,
      status: "MONITORING",
      ...(agentWallet ? { agentWallet } : {}),
    },
  });
  await appendLifecycle(id, "paid", { payer: agentWallet, nonce: paymentNonce.slice(0, 10) + "…" });
  return res;
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

// Oneshot capture row — allowlist-filtered by the dataplane, written per block inside
// the same transaction as metering + the cursor.
export type CaptureTransferInput = {
  chain: string;
  blockNum: number | bigint;
  blockTimestamp: Date;
  txHash: string;
  logIndex: number;
  contract: string;
  from: string;
  to: string;
  amount: bigint;
};

export async function meterAndCommit(
  byIntent: Map<string, number>,
  events: MatchEventInput[],
  cursor: string,
  blockNum: number,
  capture: CaptureTransferInput[] = [],
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
    // Oneshot lookback capture (3.4): pre-filtered to the allowlist by the dataplane,
    // inserted in the SAME transaction as the cursor — the cursor never advances past
    // uncaptured blocks. skipDuplicates + the (block, tx, log) unique key make replays
    // and post-undo reprocessing idempotent.
    if (capture.length > 0) {
      await tx.processedTransfer.createMany({
        data: capture.map((c) => ({
          chain: c.chain,
          blockNum: Number(c.blockNum),
          blockTimestamp: c.blockTimestamp,
          txHash: c.txHash,
          logIndex: c.logIndex,
          contract: c.contract,
          from: c.from,
          to: c.to,
          amount: c.amount,
        })),
        skipDuplicates: true,
      });
    }
    await tx.substreamsCursor.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", cursor, blockNum },
      update: { cursor, blockNum },
    });
    return totals;
  });
}

// Lookback query for the oneshot endpoint: the most recent `maxLookbackBlocks` behind
// the stream cursor, filtered to one contract (and optionally a minimum amount — the
// column is BigInt so the comparison is exact server-side), newest first.
export async function lookbackTransfers(params: {
  contract: string;
  minAmountAtomic?: bigint;
  maxLookbackBlocks: number;
  limit: number;
}) {
  const head = await prisma.substreamsCursor.findUnique({ where: { id: "singleton" } });
  if (!head) return { head: null as { blockNum: number } | null, window: null as { fromBlock: number; toBlock: number } | null, transfers: [] };
  const fromBlock = Math.max(0, head.blockNum - params.maxLookbackBlocks);
  const transfers = await prisma.processedTransfer.findMany({
    where: {
      chain: process.env.DATA_CHAIN ?? "ethereum-mainnet",
      contract: params.contract.toLowerCase(),
      blockNum: { gte: fromBlock, lte: head.blockNum },
      ...(params.minAmountAtomic !== undefined ? { amount: { gte: params.minAmountAtomic } } : {}),
    },
    orderBy: [{ blockNum: "desc" }, { logIndex: "asc" }],
    take: params.limit,
  });
  return { head: { blockNum: head.blockNum }, window: { fromBlock, toBlock: head.blockNum }, transfers };
}

// Retention prune for the capture table — called by the sweeps (startup + minute).
export async function pruneProcessedTransfers(retentionHours: number) {
  const res = await prisma.processedTransfer.deleteMany({
    where: { createdAt: { lt: new Date(Date.now() - retentionHours * 3_600_000) } },
  });
  return res.count;
}

// Post-undo cleanup: captured rows above the reverted cursor belong to undone blocks —
// the replay re-captures them, so anything above the cursor head is garbage.
export async function pruneCapturesAboveBlock(blockNum: number) {
  const res = await prisma.processedTransfer.deleteMany({ where: { blockNum: { gt: blockNum } } });
  return res.count;
}

// ── Single-writer lease ─────────────────────────────────────────────────────
// Enforces the ops rule "exactly one backend instance may stream against this DB" in
// code: a heartbeat lease on a singleton row. A fresh lease held by another holder
// cannot be claimed; a stale one (heartbeat older than the TTL — the holder crashed)
// can. The CAS lives in the SQL so concurrent claims are decided atomically.

// 3 missed heartbeats (10s cadence) = stale. After an unclean crash, a supervisor
// restart within the TTL exits; the next one takes over.
export const LEASE_TTL_MS = 30_000;

// Attempt to claim/re-claim the lease for `holder`. True iff this holder now owns it:
// - no row → insert (claimed)
// - row held by this holder → refresh (idempotent re-claim)
// - row held by another holder with a STALE heartbeat → take over
// - row held by another holder with a FRESH heartbeat → false (someone else streams)
export async function claimProcessLease(holder: string, ttlMs: number = LEASE_TTL_MS): Promise<boolean> {
  const cutoff = new Date(Date.now() - ttlMs);
  const res = await prisma.$executeRaw`
    INSERT INTO process_lease (id, holder, "heartbeat_at")
    VALUES ('singleton', ${holder}, now())
    ON CONFLICT (id) DO UPDATE
      SET holder = ${holder}, "heartbeat_at" = now()
      WHERE process_lease.holder = ${holder} OR process_lease."heartbeat_at" < ${cutoff}
  `;
  return res === 1;
}

// Heartbeat: keep the lease only if this holder still owns it. 0 = lease lost.
export async function renewProcessLease(holder: string): Promise<boolean> {
  const res = await prisma.$executeRaw`
    UPDATE process_lease SET "heartbeat_at" = now()
    WHERE id = 'singleton' AND holder = ${holder}
  `;
  return res === 1;
}

// Graceful release — only ever deletes OUR row (a wrong-holder delete is a no-op).
export async function releaseProcessLease(holder: string): Promise<void> {
  await prisma.$executeRaw`DELETE FROM process_lease WHERE id = 'singleton' AND holder = ${holder}`;
}

export async function getProcessLease(): Promise<{ holder: string; heartbeatAt: Date } | null> {
  const row = await prisma.processLease.findUnique({ where: { id: "singleton" } });
  return row ? { holder: row.holder, heartbeatAt: row.heartbeatAt } : null;
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
  const res = await prisma.intent.updateMany({ where: { id, startBlockNum: null }, data: { startBlockNum: blockNum } });
  if (res.count === 1) await appendLifecycle(id, "window_opened", { start_block: blockNum });
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
  const res = await prisma.intent.update({
    where: { id },
    data: { status: "SETTLED", settlementTxHash, settledAmountAtomic },
  });
  await appendLifecycle(id, "settled", { tx: settlementTxHash, amount_charged_atomic: settledAmountAtomic });
  return res;
}

export async function markSettleFailed(id: string) {
  const res = await prisma.intent.update({ where: { id }, data: { status: "SETTLE_FAILED" } });
  await appendLifecycle(id, "settle_failed");
  return res;
}

export async function markTimeout(id: string, settledAmountAtomic?: string, settlementTxHash?: string) {
  const res = await prisma.intent.update({
    where: { id },
    data: {
      status: "TIMEOUT",
      ...(settledAmountAtomic ? { settledAmountAtomic } : {}),
      ...(settlementTxHash ? { settlementTxHash } : {}),
    },
  });
  await appendLifecycle(
    id,
    "expired",
    settlementTxHash
      ? { tx: settlementTxHash, amount_charged_atomic: settledAmountAtomic }
      : { note: "no blocks processed — nothing charged" },
  );
  return res;
}

// Agent-side annotations (the flow-chart's optional LLM rows): length-capped, appended
// with the `agent:` prefix so they can't collide with backend step names.
export async function annotateIntent(id: string, step: string, detail?: Record<string, unknown>): Promise<boolean> {
  const intent = await prisma.intent.findUnique({ where: { id }, select: { id: true } });
  if (!intent) return false;
  await appendLifecycle(id, `agent: ${step.slice(0, 40)}`, detail);
  return true;
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
