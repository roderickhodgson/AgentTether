/**
 * Unit tests for the router's pure decision logic (extracted for the suite).
 * The HTTP-branch behavior is covered separately in intentsRouter.http.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  isAcceptableWebhook,
  advertisedMaxTimeoutSeconds,
  DEADLINE_BUFFER_S,
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

describe("advertisedMaxTimeoutSeconds", () => {
  it("gives the voucher ttl + the sweep buffer", () => {
    expect(advertisedMaxTimeoutSeconds(600)).toBe(600 + DEADLINE_BUFFER_S);
    expect(DEADLINE_BUFFER_S).toBe(120);
  });
});
