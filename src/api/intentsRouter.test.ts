/**
 * Unit tests for the router's pure decision logic (extracted for the suite).
 * The HTTP-branch behavior is covered separately in intentsRouter.http.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  computeCeiling,
  isAcceptableWebhook,
  advertisedMaxTimeoutSeconds,
  DEADLINE_BUFFER_S,
  MAX_TTL_S,
  MIN_TTL_S,
} from "./intentsRouter.js";

describe("isAcceptableWebhook (risk #8 SSRF rules)", () => {
  it("accepts https", () => {
    expect(isAcceptableWebhook("https://agent.example.com/hook")).toBe(true);
  });

  it("accepts loopback http — demo receivers and the Phase 5 Flask server", () => {
    expect(isAcceptableWebhook("http://localhost:9099/hook")).toBe(true);
    expect(isAcceptableWebhook("http://127.0.0.1:9099/hook")).toBe(true);
    expect(isAcceptableWebhook("http://localhost/hook")).toBe(true);
    expect(isAcceptableWebhook("http://127.0.0.1/")).toBe(true);
  });

  it("rejects lookalike hosts that merely contain 'localhost'", () => {
    expect(isAcceptableWebhook("http://localhost.evil.com/hook")).toBe(false);
    expect(isAcceptableWebhook("http://127.0.0.1.evil.com/hook")).toBe(false);
  });

  it("rejects plain-http public hosts and other schemes", () => {
    expect(isAcceptableWebhook("http://example.com/hook")).toBe(false);
    expect(isAcceptableWebhook("ftp://localhost/hook")).toBe(false);
    expect(isAcceptableWebhook("")).toBe(false);
  });
});

describe("computeCeiling", () => {
  it("matches the live-observed 402 amount: ttl 1800s → rate × 30 × 5 = 278,700", () => {
    // The stream client's default intent produced exactly this ceiling on day one.
    expect(computeCeiling({ ttl_seconds: 1800 })).toEqual({
      ttl: 1800,
      rate: "1858",
      maxLimit: (1858n * 30n * 5n).toString(),
    });
  });

  it("clamps TTL into [MIN_TTL_S, MAX_TTL_S] and floors fractions", () => {
    expect(computeCeiling({ ttl_seconds: 10 }).ttl).toBe(MIN_TTL_S);
    expect(computeCeiling({ ttl_seconds: MAX_TTL_S * 10 }).ttl).toBe(MAX_TTL_S);
    expect(computeCeiling({ ttl_seconds: 90.9 }).ttl).toBe(90);
    expect(computeCeiling({ ttl_seconds: 60 }).ttl).toBe(60);
  });

  it("treats a missing TTL as the minimum", () => {
    expect(computeCeiling({}).ttl).toBe(MIN_TTL_S);
    expect(computeCeiling({ ttl_seconds: Number.NaN }).ttl).toBe(MIN_TTL_S);
  });

  it("ceilings use ≥ 1 minute even for sub-minute TTLs", () => {
    // ttl clamps to 60 anyway; this pins the Math.max(1, ...) guard for any future
    // MIN_TTL_S change — one minute of expected matches is the floor.
    const { maxLimit } = computeCeiling({ ttl_seconds: MIN_TTL_S, rate_per_event_atomic: "1000" });
    expect(maxLimit).toBe("5000"); // 1 minute × 5 matches/min × rate
  });

  it("honors an explicit atomic ceiling and an explicit rate", () => {
    expect(computeCeiling({ ttl_seconds: 600, max_limit_atomic: "42" }).maxLimit).toBe("42");
    expect(computeCeiling({ ttl_seconds: 600, rate_per_event_atomic: "7" }).maxLimit).toBe((7n * 10n * 5n).toString());
  });

  it("ignores malformed rate/max_limit strings (validation also rejects them upstream)", () => {
    expect(computeCeiling({ ttl_seconds: 600, rate_per_event_atomic: "-5" }).rate).toBe("1858");
    expect(computeCeiling({ ttl_seconds: 600, max_limit_atomic: "1.5" }).maxLimit).not.toBe("1.5");
  });
});

describe("advertisedMaxTimeoutSeconds", () => {
  it("gives the voucher ttl + the sweep buffer", () => {
    expect(advertisedMaxTimeoutSeconds(600)).toBe(600 + DEADLINE_BUFFER_S);
    expect(DEADLINE_BUFFER_S).toBe(120);
  });
});
