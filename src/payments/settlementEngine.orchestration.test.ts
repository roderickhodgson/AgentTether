/**
 * Orchestration tests for the settlement engine: the full state machine with the DB,
 * facilitator and network mocked away — every path Phase 4 earned live, now in
 * milliseconds. The real-chain and real-money versions of these paths live in
 * spikes/settlement-direct.ts and spikes/settlement-e2e.ts (verify:live).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Intent } from "@prisma/client";
import { executeSuccessSettlement, executeTimeoutSettlement, runSettlementSweep } from "./settlementEngine.js";
import * as db from "../db.js";
import { facilitator } from "./facilitator.js";

const AGENT = "0xagent";
const RECEIVER = vi.hoisted(() => "0xreceiver");
const WEBHOOK = "http://127.0.0.1:9099/hook";
const TX = "0xsettlementtx";

vi.mock("../db.js", () => ({
  getIntent: vi.fn(),
  getSettlementCandidates: vi.fn(),
  getCursor: vi.fn(),
  setStartBlockNum: vi.fn(),
  windowOver: vi.fn(),
  claimForSettlement: vi.fn(),
  claimStaleSettlement: vi.fn(),
  markSettled: vi.fn(),
  markSettleFailed: vi.fn(),
  markTimeout: vi.fn(),
}));

vi.mock("./facilitator.js", () => ({
  NETWORK: "eip155:84532",
  PAY_TO_ADDRESS: RECEIVER,
  facilitator: { settle: vi.fn() },
  txExplorerUrl: (txHash: string) => `https://sepolia.basescan.org/tx/${txHash}`,
  voucherPermittedAmount: (payload: unknown) =>
    (payload as { accepted?: { amount?: string } } | null)?.accepted?.amount ?? null,
}));

const mockedDb = vi.mocked(db);
const mockedSettle = vi.mocked(facilitator.settle);

const requirements = {
  scheme: "upto",
  network: "eip155:84532",
  asset: "0xusdc",
  amount: "5000",
  payTo: RECEIVER,
  maxTimeoutSeconds: 720,
  extra: { name: "USDC", version: "2", facilitatorAddress: "0xfac" },
};

const storedEvent = {
  chain: "ethereum-mainnet",
  block: 1,
  blockTimestamp: "2026-09-05T12:00:00.000Z",
  txHash: "0xmatch",
  logIndex: 0,
  from: "0xfrom",
  to: "0xto",
  amount: "1000000000",
};

function intentFixture(over: Partial<Intent> = {}): Intent {
  return {
    id: "i1",
    status: "MONITORING",
    agentWallet: AGENT,
    targetContract: "0xtoken",
    eventsMatched: 38,
    perBlockRateAtomic: "100",
    budgetBlocks: 50,
    startBlockNum: 1000,
    maxLimitAtomic: "5000",
    paymentNonce: "123",
    paymentPayload: { accepted: requirements, payload: { permit2Authorization: { nonce: "123" } } },
    eventCondition: { minAmount: "1" },
    webhookUrl: WEBHOOK,
    matchedEvents: [storedEvent],
    settlementTxHash: null,
    settledAmountAtomic: null,
    updatedAt: new Date(),
    ttlTimestamp: new Date(Date.now() + 600_000),
    createdAt: new Date(Date.now() - 60_000),
    ...over,
  } as unknown as Intent;
}

type RecordedCall = { url: string; body: Record<string, unknown> };
const webhookCalls: RecordedCall[] = [];
let rpcReceipt: { status: string } | null = null;
let webhookFailures = 0;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  webhookCalls.length = 0;
  rpcReceipt = { status: "0x1" };
  webhookFailures = 0;
  mockedDb.claimForSettlement.mockResolvedValue(true);
  mockedDb.claimStaleSettlement.mockResolvedValue(true);
  mockedDb.getCursor.mockResolvedValue({ id: "singleton", cursor: "0xtest", blockNum: 1037, updatedAt: new Date() });
  mockedDb.getIntent.mockImplementation(async (id: string) => intentFixture({ id }));
  mockedDb.markSettled.mockImplementation(async (id: string, tx: string, amount: string) =>
    intentFixture({ id, status: "SETTLED", settlementTxHash: tx, settledAmountAtomic: amount }));
  mockedDb.markTimeout.mockImplementation(async (id: string, amount?: string, tx?: string) =>
    intentFixture({ id, status: "TIMEOUT", settledAmountAtomic: amount, settlementTxHash: tx }));
  mockedDb.markSettleFailed.mockImplementation(async (id: string) => intentFixture({ id, status: "SETTLE_FAILED" }));
  mockedSettle.mockResolvedValue({ success: true, transaction: TX } as never);

  fetchMock = vi.fn(async (input: unknown, init?: { body?: string }) => {
    const url = String(input);
    if (url.includes("127.0.0.1:9099")) {
      if (webhookFailures > 0) {
        webhookFailures -= 1;
        throw new Error("webhook down");
      }
      webhookCalls.push({ url, body: JSON.parse(init?.body ?? "{}") });
      return new Response("ok", { status: 200 });
    }
    if (url.includes("sepolia.base.org")) {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: rpcReceipt }), { status: 200 });
    }
    return new Response("unexpected fetch target", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("executeSuccessSettlement", () => {
  it("settles the metered actual, then — receipt-gated — delivers the webhook with event data", async () => {
    await executeSuccessSettlement("i1");

    // settle called with the voucher's accepted requirements and the capped actual
    expect(mockedSettle).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.anything() }),
      expect.objectContaining({ amount: "3800" }),
    );
    expect(mockedDb.markSettled).toHaveBeenCalledWith("i1", TX, "3800");
    expect(mockedDb.markSettleFailed).not.toHaveBeenCalled();
    expect(mockedDb.markTimeout).not.toHaveBeenCalled();

    expect(webhookCalls).toHaveLength(1);
    const notice = webhookCalls[0].body;
    expect(notice).toMatchObject({
      type: "settlement.confirmed",
      intent_id: "i1",
      agent_wallet: AGENT,
      pay_to: RECEIVER,
      tx_hash: TX,
      amount_charged_atomic: "3800",
      events_matched: 38,
      // the fixture stores 1 event against 38 matched — the cap/truncation flag in action
      events_truncated: true,
    });
    expect((notice.events as unknown[])[0]).toMatchObject({ tx_hash: "0xmatch", amount_atomic: "1000000000" });
  });

  it("never delivers without a confirmed receipt — stays SETTLING (fail-closed)", async () => {
    vi.useFakeTimers();
    rpcReceipt = null; // the settlement tx never shows a receipt within the poll window
    const pending = executeSuccessSettlement("i1");
    await vi.advanceTimersByTimeAsync(65_000);
    await pending;

    expect(mockedDb.markSettled).not.toHaveBeenCalled();
    expect(mockedDb.markTimeout).not.toHaveBeenCalled();
    expect(mockedDb.markSettleFailed).not.toHaveBeenCalled();
    expect(webhookCalls).toHaveLength(0);
  });

  it("a CAS loser no-ops entirely — the double-drive guard", async () => {
    mockedDb.claimForSettlement.mockResolvedValue(false);
    await executeSuccessSettlement("i1");
    expect(mockedSettle).not.toHaveBeenCalled();
    expect(mockedDb.markSettled).not.toHaveBeenCalled();
    expect(webhookCalls).toHaveLength(0);
  });

  it("re-drives a stale SETTLING claim — the sweep retry after a transient rejection (found live)", async () => {
    mockedDb.getIntent.mockResolvedValue(intentFixture({ status: "SETTLING" }));
    await executeSuccessSettlement("i1");
    expect(mockedDb.claimStaleSettlement).toHaveBeenCalledWith("i1");
    expect(mockedSettle).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ amount: "3800" }));
    expect(mockedDb.markSettled).toHaveBeenCalledWith("i1", TX, "3800");
  });

  it("a not-yet-stale SETTLING claim is left alone — the in-flight settle owns it", async () => {
    mockedDb.getIntent.mockResolvedValue(intentFixture({ status: "SETTLING" }));
    mockedDb.claimStaleSettlement.mockResolvedValue(false);
    await executeSuccessSettlement("i1");
    expect(mockedSettle).not.toHaveBeenCalled();
    expect(mockedDb.markSettled).not.toHaveBeenCalled();
  });

  it("rejects by deadline class → TIMEOUT uncollected, notice without data", async () => {
    mockedSettle.mockResolvedValue({ success: false, errorReason: "permit2_deadline_expired" } as never);
    await executeSuccessSettlement("i1");
    expect(mockedDb.markTimeout).toHaveBeenCalledWith("i1");
    expect(mockedDb.markSettled).not.toHaveBeenCalled();
    expect(mockedDb.markSettleFailed).not.toHaveBeenCalled();
    const notice = webhookCalls[0]?.body;
    expect(notice).toMatchObject({ type: "intent.timeout", intent_id: "i1" });
    expect((notice?.events as unknown[]) ?? []).toHaveLength(0);
  });

  it("rejects structural → SETTLE_FAILED", async () => {
    mockedSettle.mockResolvedValue({ success: false, errorReason: "invalid signature" } as never);
    await executeSuccessSettlement("i1");
    expect(mockedDb.markSettleFailed).toHaveBeenCalledWith("i1");
    expect(webhookCalls).toHaveLength(0);
  });

  it("rejects transient → stays SETTLING for the sweep, marks nothing", async () => {
    mockedSettle.mockResolvedValue({
      success: false,
      errorReason: "invalid_exact_evm_transaction_failed: Missing or invalid parameters.",
    } as never);
    await executeSuccessSettlement("i1");
    expect(mockedDb.markSettleFailed).not.toHaveBeenCalled();
    expect(mockedDb.markTimeout).not.toHaveBeenCalled();
    expect(mockedDb.markSettled).not.toHaveBeenCalled();
    expect(webhookCalls).toHaveLength(0);
  });

  it("rejects uncertain (consumed nonce) → stays SETTLING, never claims failure", async () => {
    mockedSettle.mockResolvedValue({ success: false, errorReason: "permit2 nonce already used" } as never);
    await executeSuccessSettlement("i1");
    expect(mockedDb.markSettleFailed).not.toHaveBeenCalled();
    expect(mockedDb.markTimeout).not.toHaveBeenCalled();
  });

  it("webhook exhaustion logs but the settlement stands (SETTLED regardless)", async () => {
    vi.useFakeTimers();
    webhookFailures = 999;
    const pending = executeSuccessSettlement("i1");
    await vi.advanceTimersByTimeAsync(60_000); // 3 attempts × (10s timeout + 2s backoff) worst case
    await pending;
    expect(mockedDb.markSettled).toHaveBeenCalledWith("i1", TX, "3800");
    const webhookAttempts = fetchMock.mock.calls.filter(([u]) => String(u).includes("9099")).length;
    expect(webhookAttempts).toBe(3); // delivery attempts only — the receipt poll is a separate fetch
  });

  it("an intent without a stored voucher lands SETTLE_FAILED", async () => {
    mockedDb.getIntent.mockResolvedValue(intentFixture({ paymentPayload: null }));
    await executeSuccessSettlement("i1");
    expect(mockedSettle).not.toHaveBeenCalled();
    expect(mockedDb.markSettleFailed).toHaveBeenCalledWith("i1");
  });
});

describe("executeTimeoutSettlement", () => {
  it("zero metered usage → $0: no settle call, TIMEOUT, notice without data", async () => {
    mockedDb.getIntent.mockResolvedValue(intentFixture({ eventsMatched: 0, matchedEvents: [], startBlockNum: null }));
    await executeTimeoutSettlement("i1");
    expect(mockedSettle).not.toHaveBeenCalled();
    expect(mockedDb.markTimeout).toHaveBeenCalledWith("i1");
    const notice = webhookCalls[0]?.body;
    expect(notice).toMatchObject({ type: "intent.timeout", intent_id: "i1", events_matched: 0 });
    expect((notice?.events as unknown[]) ?? []).toHaveLength(0);
    expect(notice?.tx_hash).toBeUndefined();
  });

  it("metered usage → settles the actual and delivers the data (metered timeout branch)", async () => {
    await executeTimeoutSettlement("i1");
    expect(mockedSettle).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ amount: "3800" }));
    expect(mockedDb.markTimeout).toHaveBeenCalledWith("i1", "3800", TX);
    const notice = webhookCalls[0]?.body;
    expect(notice).toMatchObject({ type: "intent.timeout", tx_hash: TX, amount_charged_atomic: "3800" });
    expect((notice?.events as unknown[]) ?? []).toHaveLength(1);
  });
});

describe("runSettlementSweep (dispatch)", () => {
  it("window-over candidates go to the timeout path, metered-but-unsettled to the success path", async () => {
    const now = new Date();
    mockedDb.windowOver.mockImplementation((intent: { ttlTimestamp: Date }) => intent.ttlTimestamp.getTime() < Date.now());
    mockedDb.getSettlementCandidates.mockResolvedValue([
      intentFixture({ id: "expired", ttlTimestamp: new Date(now.getTime() - 1000) }),
      intentFixture({ id: "lost-trigger", ttlTimestamp: new Date(now.getTime() + 600_000) }),
    ] as never);
    await runSettlementSweep(now);
    // both settle; dispatch is invisible in the mocks, but no candidate is skipped
    expect(mockedSettle).toHaveBeenCalledTimes(2);
  });

  it("a candidate that throws does not abort the sweep", async () => {
    mockedDb.getSettlementCandidates.mockResolvedValue([
      intentFixture({ id: "explodes", ttlTimestamp: new Date(Date.now() - 1000) }),
    ] as never);
    mockedSettle.mockRejectedValue(new Error("facilitator down"));
    const acted = await runSettlementSweep();
    expect(acted).toBe(0); // logged, retried next pass — the sweep survives
  });
});
