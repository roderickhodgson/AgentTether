/**
 * Unit tests for the data-plane matching predicate — the semantics that were only
 * proven live until now (the 9.4h downtime replay, README 2.3): catch-up must neither
 * retroactively bill events that predate an intent nor meter past its TTL, and a bad
 * condition must disable an intent rather than crash the stream.
 */
import { describe, expect, it } from "vitest";
import { matchesIntent, type MatchableIntent } from "./substreamsManager.js";

const CREATED_AT = new Date("2026-09-05T12:00:00.000Z");
const TTL = new Date("2026-09-05T12:10:00.000Z"); // 10-minute window
const BLOCK_TIME = new Date("2026-09-05T12:05:00.000Z"); // mid-window

const intent = (over: Partial<MatchableIntent> = {}): MatchableIntent => ({
  targetContract: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  eventCondition: { minAmount: "1000000000" }, // 1,000 USDC
  createdAt: CREATED_AT,
  ttlTimestamp: TTL,
  ...over,
});

const transfer = (over: Partial<{ contract: string; value: string }> = {}) => ({
  contract: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  value: "1500000000",
  ...over,
});

describe("matchesIntent — window guards (2.3 catch-up semantics)", () => {
  it("matches an in-window, in-contract, above-threshold transfer", () => {
    expect(matchesIntent(intent(), transfer(), BLOCK_TIME)).toBe(true);
  });

  it("catch-up guard: a block predating the intent never meters — fresh intents must not match history", () => {
    expect(matchesIntent(intent(), transfer(), new Date("2026-09-05T11:59:59.999Z"))).toBe(false);
  });

  it("TTL guard: a block after ttlTimestamp never meters — downtime cannot charge expired intents", () => {
    expect(matchesIntent(intent(), transfer(), new Date("2026-09-05T12:10:00.001Z"))).toBe(false);
  });

  it("window boundaries are inclusive of the exact timestamps", () => {
    expect(matchesIntent(intent(), transfer(), CREATED_AT)).toBe(true);
    expect(matchesIntent(intent(), transfer(), TTL)).toBe(true);
  });

  it("an absent block timestamp leaves the time guards open (documented fail-open default)", () => {
    // A stream block with no usable Clock must not silently disqualify matches; the
    // staleClock case meters on time-agnostic evidence instead of losing events.
    const preCreation = new Date("2026-09-05T11:00:00.000Z");
    expect(matchesIntent(intent(), transfer(), null)).toBe(true);
    expect(matchesIntent(intent(), transfer(), preCreation)).toBe(false); // but a KNOWN early block is still guarded
  });
});

describe("matchesIntent — contract and amount conditions", () => {
  it("contract comparison is case-insensitive on the hex", () => {
    expect(matchesIntent(intent(), transfer({ contract: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" }), BLOCK_TIME)).toBe(true);
    expect(matchesIntent(intent({ targetContract: "0xA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48" }), transfer(), BLOCK_TIME)).toBe(true);
  });

  it("rejects other contracts", () => {
    expect(matchesIntent(intent(), transfer({ contract: "0x0000000000000000000000000000000000000001" }), BLOCK_TIME)).toBe(false);
  });

  it("amount is inclusive: a transfer exactly at minAmount matches", () => {
    expect(matchesIntent(intent(), transfer({ value: "1000000000" }), BLOCK_TIME)).toBe(true);
    expect(matchesIntent(intent(), transfer({ value: "999999999" }), BLOCK_TIME)).toBe(false);
  });

  it("zero-decimal USDC arithmetic is exact — no float rounding at the threshold", () => {
    // 1,000.000001 USDC vs 1,000 USDC: the classic float bug would call these equal.
    expect(matchesIntent(intent(), transfer({ value: "1000000001" }), BLOCK_TIME)).toBe(true);
    expect(matchesIntent(intent(), transfer({ value: "1000000000" }), BLOCK_TIME)).toBe(true);
  });
});

describe("matchesIntent — malformed conditions disable, never crash", () => {
  it("a missing minAmount disables the intent", () => {
    expect(matchesIntent(intent({ eventCondition: {} }), transfer(), BLOCK_TIME)).toBe(false);
    expect(matchesIntent(intent({ eventCondition: null }), transfer(), BLOCK_TIME)).toBe(false);
  });

  it("a non-numeric minAmount disables the intent instead of throwing", () => {
    expect(matchesIntent(intent({ eventCondition: { minAmount: "1.5 ETH" } }), transfer(), BLOCK_TIME)).toBe(false);
    expect(matchesIntent(intent({ eventCondition: { minAmount: "" } }), transfer(), BLOCK_TIME)).toBe(false);
  });

  it("a non-numeric transfer value disables the match instead of throwing", () => {
    expect(matchesIntent(intent(), transfer({ value: "not-a-number" }), BLOCK_TIME)).toBe(false);
  });
});
