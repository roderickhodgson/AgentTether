/**
 * DB-backed integration tests against the Neon BRANCH (TEST_DATABASE_URL).
 *
 * The branch is an isolated schema+data copy, so these are safe to run even while the
 * demo database streams. Every row this suite creates is tagged `agentWallet =
 * "test-suite-agent"` and removed in afterAll; the branch's own data is never touched.
 *
 * Skips cleanly when TEST_DATABASE_URL is unset (e.g. in CI, where only the fast suite
 * runs): PrismaClient is constructed against a throwaway placeholder URL that is never
 * connected to, because every test is skipped.
 */
import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Intent } from "@prisma/client";

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://placeholder:placeholder@localhost:5432/placeholder";

const db = await import("./db.js");
const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const AGENT = "test-suite-agent";
const NONCE = `test-nonce-${Date.now()}`;

async function seedIntent(over: Partial<Intent> = {}, nonceSuffix = ""): Promise<Intent> {
  const intent = await db.createIntent({
    agentWallet: AGENT,
    targetContract: "0x00000000000000000000000000000000000000aa",
    ttlTimestamp: new Date(Date.now() + 600_000),
    maxLimitAtomic: "1000000",
    perBlockRateAtomic: "10",
    budgetBlocks: 100000,
    eventCondition: { minAmount: "1" },
  });
  await db.storeVerifiedPayment(intent.id, `${NONCE}-${intent.id.slice(0, 8)}${nonceSuffix}`, { test: true });
  if (Object.keys(over).length > 0) {
    return db.prisma.intent.update({ where: { id: intent.id }, data: over as never });
  }
  return db.prisma.intent.findUniqueOrThrow({ where: { id: intent.id } });
}

const evt = (i: number, intentId: string) => ({
  intentId,
  chain: "ethereum-mainnet",
  block: 100 + i,
  blockTimestamp: new Date().toISOString(),
  txHash: `0xevt${i}`,
  logIndex: i,
  from: "0xfrom",
  to: "0xto",
  amount: "2",
});

beforeAll(async () => {
  // sanity: the branch is reachable and has the current schema
  await db.prisma.intent.findMany({ take: 1 });
});

afterAll(async () => {
  await db.prisma.intent.deleteMany({ where: { agentWallet: AGENT } });
  await db.prisma.$disconnect();
});

d("db integration — settlement claim (CAS)", () => {
  it("claims exactly once: MONITORING → SETTLING wins, the second claim no-ops", async () => {
    const intent = await seedIntent();
    expect(await db.claimForSettlement(intent.id)).toBe(true);
    expect(await db.claimForSettlement(intent.id)).toBe(false);

    // a bare PENDING_PAYMENT intent (no stored voucher) is not claimable
    const stillPending = await db.createIntent({
      agentWallet: AGENT,
      targetContract: "0x00000000000000000000000000000000000000aa",
      ttlTimestamp: new Date(Date.now() + 600_000),
      maxLimitAtomic: "1000000",
      perBlockRateAtomic: "10",
    budgetBlocks: 100000,
      eventCondition: { minAmount: "1" },
    });
    expect(await db.claimForSettlement(stillPending.id)).toBe(false);
  });

  it("re-drive claim: only STALE SETTLING re-drives, and winning refreshes the claim window", async () => {
    const intent = await seedIntent();
    await db.claimForSettlement(intent.id); // → SETTLING, updatedAt = now

    expect(await db.claimStaleSettlement(intent.id)).toBe(false); // fresh claim — a settle may be in flight

    await db.prisma.intent.update({
      where: { id: intent.id },
      data: { updatedAt: new Date(Date.now() - 3 * 60_000) },
    });
    expect(await db.claimStaleSettlement(intent.id)).toBe(true); // stale → the sweep wins the retry
    expect(await db.claimStaleSettlement(intent.id)).toBe(false); // winning refreshed updatedAt
  });
});

d("db integration — meterAndCommit", () => {
  it("meters, appends matched events and advances the cursor in one commit", async () => {
    const intent = await seedIntent();

    const totals1 = await db.meterAndCommit(new Map([[intent.id, 3]]), [evt(1, intent.id), evt(2, intent.id), evt(3, intent.id)], "test-cursor-a", 100);
    expect(totals1.get(intent.id)).toBe(3);
    let row = await db.prisma.intent.findUniqueOrThrow({ where: { id: intent.id } });
    expect(row.eventsMatched).toBe(3);
    expect((row.matchedEvents as unknown[]).map((e) => (e as { txHash: string }).txHash)).toEqual(["0xevt1", "0xevt2", "0xevt3"]);

    const totals2 = await db.meterAndCommit(new Map([[intent.id, 2]]), [evt(4, intent.id), evt(5, intent.id)], "test-cursor-b", 101);
    expect(totals2.get(intent.id)).toBe(5);
    row = await db.prisma.intent.findUniqueOrThrow({ where: { id: intent.id } });
    expect(row.eventsMatched).toBe(5);
    expect(row.matchedEvents).toHaveLength(5);

    const cursor = await db.getCursor();
    expect(cursor?.cursor).toBe("test-cursor-b");
    expect(cursor?.blockNum).toBe(101);
  });

  it("caps matchedEvents at MAX_PERSISTED_EVENTS while the counter keeps counting", async () => {
    const intent = await seedIntent();
    const cap = await import("./db.js").then((m) => m.MAX_PERSISTED_EVENTS);
    const full = Array.from({ length: cap }, (_, i) => ({ ...evt(i, intent.id), txHash: `0xpre${i}` }));
    await db.prisma.intent.update({ where: { id: intent.id }, data: { matchedEvents: full, eventsMatched: cap } });

    const totals = await db.meterAndCommit(new Map([[intent.id, 7]]), [evt(999, intent.id)], "test-cursor-c", 102);
    expect(totals.get(intent.id)).toBe(cap + 7); // the counter is uncapped
    const row = await db.prisma.intent.findUniqueOrThrow({ where: { id: intent.id } });
    expect(row.matchedEvents).toHaveLength(cap); // the payload is capped
    expect((row.matchedEvents as { txHash: string }[])[0].txHash).toBe("0xpre0"); // first-50 retention
  });

  it("an intent deleted mid-block drops out of metering; the cursor still advances", async () => {
    const intent = await seedIntent();
    await db.prisma.intent.delete({ where: { id: intent.id } });
    const totals = await db.meterAndCommit(new Map([[intent.id, 2]]), [evt(1, intent.id), evt(2, intent.id)], "test-cursor-d", 103);
    expect(totals.size).toBe(0);
    const cursor = await db.getCursor();
    expect(cursor?.cursor).toBe("test-cursor-d");
  });
});

d("db integration — payment nonce uniqueness", () => {
  it("rejects a second voucher bound to the same nonce (idempotency key)", async () => {
    const a = await seedIntent({}, "-nonce-unique");
    const nonce = `${NONCE}-shared-${a.id.slice(0, 8)}`;
    await db.prisma.intent.update({ where: { id: a.id }, data: { paymentNonce: nonce } });
    const b = await seedIntent();
    await expect(db.prisma.intent.update({ where: { id: b.id }, data: { paymentNonce: nonce } })).rejects.toThrow();
  });
});

d("db integration — getSettlementCandidates (the recovery set)", () => {
  it("returns expired, metered-unsettled and stale-SETTLING intents — and nothing else", async () => {
    const expired = await seedIntent({ ttlTimestamp: new Date(Date.now() - 1000), eventsMatched: 0 });
    const metered = await seedIntent({ eventsMatched: 4 });
    const stale = await seedIntent(
      { status: "SETTLING", updatedAt: new Date(Date.now() - 3 * 60_000) },
      "-stale",
    );
    const freshStale = await seedIntent({ status: "SETTLING" }, "-fresh-stale"); // just claimed — not stale yet
    const healthy = await seedIntent(); // in-TTL, 0 events — nothing owed
    const untouched = await db.createIntent({ agentWallet: AGENT, targetContract: "0x00", ttlTimestamp: new Date(Date.now() - 1000), maxLimitAtomic: "1", perBlockRateAtomic: "1", budgetBlocks: 1, eventCondition: { minAmount: "1" } });

    const candidates = await db.getSettlementCandidates();
    const ids = new Set(candidates.map((c) => c.id));
    expect(ids.has(expired.id)).toBe(true);
    expect(ids.has(metered.id)).toBe(true);
    expect(ids.has(stale.id)).toBe(true);
    expect(ids.has(freshStale.id)).toBe(false);
    expect(ids.has(healthy.id)).toBe(false);
    expect(ids.has(untouched.id)).toBe(false);
  });
});
