/**
 * Unit tests for the per-block pricing model (pure): TTL → block budget → quoted
 * ceiling, and the quote-vs-actual relationship that the settlement meters enforce.
 */
import { describe, expect, it, afterEach } from "vitest";
import {
  quoteWindow,
  oneshotContracts,
  oneshotLookbackBlocksMax,
  oneshotRetentionHours,
  oneshotPriceBaseAtomic,
  oneshotPriceHederaTinybars,
} from "./pricing.js";
import { blocksConsumed, settleAmountAtomic } from "../payments/settlementEngine.js";

describe("quoteWindow (ttl → block budget → quoted ceiling)", () => {
  it("converts time to blocks via the chain's block time: 1 hour on 12s mainnet = 300 blocks", () => {
    expect(quoteWindow(3600, 100n, 12)).toEqual({ ttl: 3600, budgetBlocks: 300, ceilingAtomic: "30000" });
  });

  it("rounds the budget UP to cover the window — a 61s window still buys 6 blocks at 12s", () => {
    expect(quoteWindow(61, 100n, 12).budgetBlocks).toBe(6);
    expect(quoteWindow(60, 100n, 12).budgetBlocks).toBe(5);
  });

  it("clamps TTL into [minTtlS, maxTtlS] and floors fractions", () => {
    expect(quoteWindow(10, 100n, 12).ttl).toBe(60);
    expect(quoteWindow(10_000_000, 100n, 12).ttl).toBe(86_400);
    expect(quoteWindow(90.9, 100n, 12).ttl).toBe(90);
  });

  it("treats a missing/NaN TTL as the minimum — never crashes on BigInt conversion", () => {
    expect(quoteWindow(undefined, 100n, 12).ttl).toBe(60);
    expect(quoteWindow(Number.NaN, 100n, 12).ttl).toBe(60);
    expect(quoteWindow(undefined, 100n, 12).budgetBlocks).toBe(5);
  });
});

describe("the canonical scenario — 10,000-block budget, event at block 263", () => {
  it("quotes a $1 ceiling for a 10,000-block budget and settles 263 blocks pro-rata", () => {
    const quote = quoteWindow(120_000, 100n, 12, 60, 10_000_000); // 120,000s ≈ 10,000 blocks
    expect(quote.budgetBlocks).toBe(10_000);
    expect(quote.ceilingAtomic).toBe("1000000"); // $1.00 quoted — the client's worst case
    expect(settleAmountAtomic(blocksConsumed(50_000, 10_000, 50_262), "100")).toBe("26300"); // $0.263 — reality
  });
});

describe("blocksConsumed (dual-guard termination, exact blocks)", () => {
  it("counts from the activation block through the cursor, inclusive", () => {
    expect(blocksConsumed(1000, 10_000, 1262)).toBe(263); // the canonical pro-rata case
  });

  it("caps at the quoted budget — fast chains never bill past the quote", () => {
    expect(blocksConsumed(1000, 300, 5000)).toBe(300);
  });

  it("never counts before activation — the cursor sitting behind an un-started intent is 0 blocks", () => {
    expect(blocksConsumed(1000, 300, 500)).toBe(0);
    expect(blocksConsumed(null, 300, 5000)).toBe(0); // window never opened (stream down)
    expect(blocksConsumed(1000, 300, null)).toBe(0);
  });
});

describe("settleAmountAtomic", () => {
  it("charges exactly blocks × rate — the auditable invariant", () => {
    expect(settleAmountAtomic(263, "100")).toBe("26300");
    expect(settleAmountAtomic(0, "100")).toBe("0");
  });
});

describe("oneshot config (3.4)", () => {
  afterEach(() => {
    delete process.env.ONESHOT_CONTRACTS;
    delete process.env.ONESHOT_LOOKBACK_BLOCKS_MAX;
    delete process.env.ONESHOT_RETENTION_HOURS;
    delete process.env.ONESHOT_PRICE_BASE_ATOMIC;
    delete process.env.ONESHOT_PRICE_HEDERA_TINYBAR;
  });

  it("defaults: mainnet USDC allowlist, 300-block lookback, 2h retention, $0.0005 / 0.001 ℏ", () => {
    expect(oneshotContracts()).toEqual(["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"]);
    expect(oneshotLookbackBlocksMax()).toBe(300);
    expect(oneshotRetentionHours()).toBe(2);
    expect(oneshotPriceBaseAtomic()).toBe(500n);
    expect(oneshotPriceHederaTinybars()).toBe(10000n);
  });

  it("parses a comma-separated allowlist — lowercased, whitespace and empties dropped", () => {
    process.env.ONESHOT_CONTRACTS = "0xAAA, 0xbbb ,, 0xccC";
    expect(oneshotContracts()).toEqual(["0xaaa", "0xbbb", "0xccc"]);
  });

  it("env overrides are honored for every knob", () => {
    process.env.ONESHOT_LOOKBACK_BLOCKS_MAX = "50";
    process.env.ONESHOT_RETENTION_HOURS = "24";
    process.env.ONESHOT_PRICE_BASE_ATOMIC = "1000";
    process.env.ONESHOT_PRICE_HEDERA_TINYBAR = "20000";
    expect(oneshotLookbackBlocksMax()).toBe(50);
    expect(oneshotRetentionHours()).toBe(24);
    expect(oneshotPriceBaseAtomic()).toBe(1000n);
    expect(oneshotPriceHederaTinybars()).toBe(20000n);
  });
});
