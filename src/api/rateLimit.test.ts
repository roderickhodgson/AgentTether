/**
 * Rate-limit middleware tests: the free public endpoints (intent creation, annotate,
 * recent, report) are the abuse surface — this pins the 429 behaviour (JSON error,
 * draft-7 standard headers) and the env knobs. Dummy routes — no db.js, no mocks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { makeRateLimiter } from "./rateLimit.js";

async function listen(limiter: ReturnType<typeof makeRateLimiter>) {
  const app = express();
  // mirrors the production wiring (index.ts trusts loopback X-Forwarded-For from Caddy;
  // permissive `true` is rejected outright by express-rate-limit v8's validations)
  app.set("trust proxy", "loopback");
  app.post("/t", limiter, (_req, res) => res.json({ ok: true }));
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const addr = server.address();
  if (!addr || typeof addr !== "object") throw new Error("no address");
  return { baseUrl: `http://127.0.0.1:${addr.port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const hit = (baseUrl: string) => fetch(`${baseUrl}/t`, { method: "POST" });

describe("makeRateLimiter", () => {
  it("passes the first N requests and 429s with a JSON error past the limit", async () => {
    const l = await listen(makeRateLimiter(2));
    try {
      const r1 = await hit(l.baseUrl);
      expect(r1.status).toBe(200);
      // draft-7 standard headers: one combined RateLimit field + the policy
      expect(r1.headers.get("ratelimit")).toBe("limit=2, remaining=1, reset=60");
      expect(r1.headers.get("ratelimit-policy")).toBe("2;w=60");

      expect((await hit(l.baseUrl)).status).toBe(200);

      const r3 = await hit(l.baseUrl);
      expect(r3.status).toBe(429);
      expect(((await r3.json()) as { error: string }).error).toMatch(/too many requests/);
    } finally {
      await l.close();
    }
  });

  it("one client's burst does not consume another client's budget", async () => {
    const l = await listen(makeRateLimiter(1));
    try {
      expect((await hit(l.baseUrl)).status).toBe(200);
      expect((await hit(l.baseUrl)).status).toBe(429);
      // a different source IP gets its own bucket
      expect((await fetch(`${l.baseUrl}/t`, { method: "POST", headers: { "X-Forwarded-For": "203.0.113.9" } })).status).toBe(200);
    } finally {
      await l.close();
    }
  });
});

describe("env-configured singletons", () => {
  beforeEach(() => {
    // the static import already cached the module (and its singletons) — re-evaluate
    // with the env set below so the singletons are built from it
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.RATE_LIMIT_WRITES_PER_MIN;
    delete process.env.RATE_LIMIT_READS_PER_MIN;
    vi.resetModules();
  });

  it("reads RATE_LIMIT_*_PER_MIN at construction; falls back to the defaults", async () => {
    process.env.RATE_LIMIT_WRITES_PER_MIN = "1";
    const { writeRateLimiter, readRateLimiter } = await import("./rateLimit.js");
    const l = await listen(writeRateLimiter);
    try {
      expect((await hit(l.baseUrl)).headers.get("ratelimit")).toContain("limit=1");
      expect((await hit(l.baseUrl)).status).toBe(429);
    } finally {
      await l.close();
    }
    // default (no env): 120 reads
    const l2 = await listen(readRateLimiter);
    try {
      expect((await hit(l2.baseUrl)).headers.get("ratelimit")).toBe("limit=120, remaining=119, reset=60");
    } finally {
      await l2.close();
    }
  });
});
