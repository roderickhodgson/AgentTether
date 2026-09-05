/**
 * Unit tests for the settlement engine's pure decision logic. The orchestration paths
 * (DB + facilitator + webhook) are covered in settlementEngine.orchestration.test.ts;
 * the rejection classes here encode the ladder that was earned live in Phase 4 —
 * every fixture below was observed against the hosted facilitator (see README 4.4).
 */
import { describe, expect, it } from "vitest";
import { blocksConsumed, classifySettleRejection, eventsForWebhook, settleAmountAtomic } from "./settlementEngine.js";

describe("blocksConsumed / settleAmountAtomic (per-block meter, capped at the quote)", () => {
  it("counts activation → cursor inclusive: the canonical 263-of-10,000 pro-rata case", () => {
    expect(blocksConsumed(50_000, 10_000, 50_262)).toBe(263);
    expect(settleAmountAtomic(263, "100")).toBe("26300");
  });

  it("caps at the quoted budget — fast chains never bill past the quote", () => {
    expect(blocksConsumed(1000, 300, 5000)).toBe(300);
    expect(settleAmountAtomic(300, "100")).toBe("30000");
  });

  it("never counts before activation or without a cursor — 0 blocks = $0 settle", () => {
    expect(blocksConsumed(1000, 300, 500)).toBe(0);
    expect(blocksConsumed(null, 300, 5000)).toBe(0);
    expect(blocksConsumed(1000, 300, null)).toBe(0);
    expect(settleAmountAtomic(0, "100")).toBe("0");
  });

  it("handles bigint-scale budgets without float damage", () => {
    expect(settleAmountAtomic(999_999_999, "1858")).toBe(String(999_999_999n * 1858n));
  });
});

describe("classifySettleRejection — the ladder earned live (README 4.4)", () => {
  it("consumed-nonce rejections are uncertain: money may already have moved", () => {
    expect(classifySettleRejection("permit2 nonce already used")).toBe("uncertain");
    expect(classifySettleRejection("nonce consumed by another settlement")).toBe("uncertain");
  });

  it("deadline-expired rejections void the authorization → TIMEOUT uncollected", () => {
    // Observed live when settling vouchers whose ttl+120s window had passed.
    expect(classifySettleRejection("permit2_deadline_expired")).toBe("deadline");
    expect(classifySettleRejection("signature deadline expired")).toBe("deadline"); // precedence: uncertain > deadline > structural
  });

  it("structural rejections mark SETTLE_FAILED — retrying can never succeed", () => {
    // Observed live on the fixture's synthetic voucher.
    expect(classifySettleRejection("stored voucher has no accepted requirements")).toBe("structural");
    expect(classifySettleRejection("invalid signature")).toBe("structural");
  });

  it("everything else is transient by default — the hosted facilitator bounced valid settles", () => {
    // Observed live mid-queue: a valid voucher rejected at eth_sendRawTransaction
    // (stale wallet nonce under parallel load). Retried by the sweep → settled.
    expect(classifySettleRejection("invalid_exact_evm_transaction_failed: Missing or invalid parameters.")).toBe("transient");
    expect(classifySettleRejection("permit2_allowance_required")).toBe("transient"); // tops up + retry succeeds
    expect(classifySettleRejection("")).toBe("transient");
  });

  it("uncertain outranks deadline and structural — never claim failure when money may have moved", () => {
    expect(classifySettleRejection("nonce used, deadline expired")).toBe("uncertain");
  });
});

describe("eventsForWebhook (bounded matched-event payload)", () => {
  const stored = [
    {
      chain: "ethereum-mainnet",
      block: 25910906,
      blockTimestamp: "2026-09-05T11:43:47.000Z",
      txHash: "0xabc",
      logIndex: 0,
      from: "0xfrom",
      to: "0xto",
      amount: "1000000000",
    },
  ];

  it("maps stored events to the snake_case webhook shape", () => {
    const { events, truncated } = eventsForWebhook(stored, 1);
    expect(events).toEqual([
      {
        chain: "ethereum-mainnet",
        block: 25910906,
        block_timestamp: "2026-09-05T11:43:47.000Z",
        tx_hash: "0xabc",
        log_index: 0,
        from: "0xfrom",
        to: "0xto",
        amount_atomic: "1000000000",
      },
    ]);
    expect(truncated).toBe(false);
  });

  it("flags truncation when the counter outgrew the stored cap (MAX_PERSISTED_EVENTS)", () => {
    expect(eventsForWebhook(stored, 51).truncated).toBe(true);
    expect(eventsForWebhook([], 5).truncated).toBe(true);
    expect(eventsForWebhook([], 0).truncated).toBe(false);
  });

  it("tolerates a missing/odd stored payload (e.g. fixture intents)", () => {
    expect(eventsForWebhook(null, 3)).toEqual({ events: [], truncated: true });
    expect(eventsForWebhook("garbage", 3).truncated).toBe(true);
  });
});
