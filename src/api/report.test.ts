/**
 * Unit tests for the shareable report builder (B.2): presentation-shaped output from
 * the DB row — bare-hex webhook convention converted to canonical 0x form, the three
 * settlement branches (settled / idle-settled / zero-processed), truncation flag.
 */
import { describe, expect, it } from "vitest";
import { buildReport } from "./report.js";

const base = {
  id: "intent-1",
  status: "SETTLED",
  targetContract: "A0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // bare-hex, as stored
  eventCondition: { minAmount: "1000000000" },
  createdAt: new Date("2026-09-07T19:20:00Z"),
  ttlTimestamp: new Date("2026-09-07T19:21:00Z"),
  budgetBlocks: 5,
  perBlockRateAtomic: "100",
  maxLimitAtomic: "500",
  settlementTxHash: "ceb9233dedba620e52163fe4aead79e644179296f7019e1b29342887b74380f6",
  settledAmountAtomic: "100",
  eventsMatched: 1, // matches the single stored event — not truncated
  matchedEvents: [
    {
      chain: "ethereum-mainnet",
      block: 25921049,
      blockTimestamp: "2026-09-06T21:38:35.000Z",
      txHash: "854b2c1c034563d9596ac0d1fdc7dbbe0d1fdc7dbbe0",
      logIndex: 12,
      from: "2907324285735be3512d1070a6b2b58240d4ba4c",
      to: "88e6a0c2ddd26feeb64f039a2c41296fcb3f5640",
      amount: "8824400562",
    },
  ],
};

describe("buildReport", () => {
  it("renders presentation-shaped output: 0x-prefixed, USDC named, explorer link", () => {
    const r = buildReport(base);
    expect(r.intent.asset).toBe("USDC");
    expect(r.intent.target_contract).toBe("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
    expect(r.matched.events[0].tx_hash).toBe("0x854b2c1c034563d9596ac0d1fdc7dbbe0d1fdc7dbbe0");
    expect(r.settlement.explorer_url).toBe("https://sepolia.basescan.org/tx/0xceb9233dedba620e52163fe4aead79e644179296f7019e1b29342887b74380f6");
    expect(r.matched.truncated).toBe(false);
    expect(r.disclosure).toMatch("different chains by design");
  });

  it("flags truncation when the counter exceeds the stored payload", () => {
    const r = buildReport({ ...base, eventsMatched: 100, matchedEvents: base.matchedEvents });
    expect(r.matched.truncated).toBe(true);
    expect(r.matched.count).toBe(100);
    expect(r.matched.stored).toBe(1);
  });

  it("the idle-settled branch keeps its tx and full-budget amount", () => {
    const r = buildReport({ ...base, status: "TIMEOUT", settledAmountAtomic: "500" });
    expect(r.settlement.tx_hash).toMatch(/^0x/);
    expect(r.settlement.amount_charged_atomic).toBe("500");
    expect(r.settlement.note).toMatch(/Settled on-chain/);
  });

  it("the zero-processed timeout reports nothing charged and no tx", () => {
    const r = buildReport({
      ...base,
      status: "TIMEOUT",
      settlementTxHash: null,
      settledAmountAtomic: null,
      eventsMatched: 0,
      matchedEvents: [],
    });
    expect(r.settlement.tx_hash).toBeNull();
    expect(r.settlement.explorer_url).toBeNull();
    expect(r.settlement.note).toMatch(/nothing was charged/i);
  });
});
