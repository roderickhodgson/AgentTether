/**
 * Unit tests for the oneshot endpoint's pure query validation (3.4): allowlist check,
 * lookback/limit clamping, min-amount parsing.
 */
import { describe, expect, it } from "vitest";
import { parseOneshotQuery } from "./oneshot.js";

const OPTS = { contracts: ["0xa0b8"], maxLookback: 300, maxLimit: 500 };

describe("parseOneshotQuery", () => {
  it("accepts an allowlisted contract with defaults", () => {
    const r = parseOneshotQuery({ target_contract: "0xA0B8" }, OPTS);
    expect(r).toEqual({ ok: true, query: { contract: "0xa0b8", lookback: 300, limit: 100, minAmount: undefined } });
  });

  it("rejects a contract outside the allowlist (server-owned capture, server-owned rules)", () => {
    const r = parseOneshotQuery({ target_contract: "0xdead" }, OPTS);
    expect(r).toMatchObject({ ok: false, status: 400, error: "unsupported_contract", supported: ["0xa0b8"] });
  });

  it("clamps lookback into [1, maxLookback] — the client cannot exceed the server's window", () => {
    expect(parseOneshotQuery({ target_contract: "0xa0b8", lookback_blocks: 10_000 }, OPTS)).toMatchObject({
      ok: true,
      query: { lookback: 300 },
    });
    expect(parseOneshotQuery({ target_contract: "0xa0b8", lookback_blocks: 0 }, OPTS)).toMatchObject({
      ok: true,
      query: { lookback: 1 },
    });
    expect(parseOneshotQuery({ target_contract: "0xa0b8", lookback_blocks: Number.NaN }, OPTS)).toMatchObject({
      ok: true,
      query: { lookback: 300 },
    });
  });

  it("clamps the result limit", () => {
    const big = parseOneshotQuery({ target_contract: "0xa0b8", limit: 10_000 }, OPTS);
    const zero = parseOneshotQuery({ target_contract: "0xa0b8", limit: 0 }, OPTS);
    expect(big.ok && big.query.limit).toBe(500);
    expect(zero.ok && zero.query.limit).toBe(1);
  });

  it("parses min_amount_atomic as an exact BigInt and rejects garbage / negatives", () => {
    const ok = parseOneshotQuery({ target_contract: "0xa0b8", min_amount_atomic: "1000000" }, OPTS);
    expect(ok.ok && ok.query.minAmount).toBe(1_000_000n);
    expect(parseOneshotQuery({ target_contract: "0xa0b8", min_amount_atomic: "0xnot-a-number" }, OPTS)).toMatchObject({
      ok: false,
      status: 400,
      error: "invalid_min_amount_atomic",
    });
    expect(parseOneshotQuery({ target_contract: "0xa0b8", min_amount_atomic: "-1" }, OPTS)).toMatchObject({
      ok: false,
      status: 400,
    });
  });
});
