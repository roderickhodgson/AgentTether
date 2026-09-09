/**
 * Per-IP rate limits for the unauthenticated public surface.
 *
 * The API's expensive operations are payment-gated (x402), but the free endpoints —
 * intent creation (402 issuance), annotate, recent, report — are not, so each is an
 * abuse vector: unpaid intent rows, facilitator /verify quota burn, lifecycle
 * vandalism. In-memory fixed-window limits per client IP suffice for the single-process
 * daemon (the single-writer lease guarantees one process); behind Caddy, index.ts sets
 * `trust proxy = loopback`, so req.ip is the real client IP from X-Forwarded-For.
 *
 * Limits are server-owned env config, same style as the pricing knobs.
 */
import { rateLimit, type RateLimitRequestHandler } from "express-rate-limit";

function perMinute(env: string, fallback: number): number {
  const n = Number(process.env[env]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function makeRateLimiter(limit: number, windowMs = 60_000): RateLimitRequestHandler {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({ error: "too many requests — slow down" });
    },
  });
}

// Writes: intent creation (402 issuance AND voucher verify — one bucket) + annotate.
export const writeRateLimiter = makeRateLimiter(perMinute("RATE_LIMIT_WRITES_PER_MIN", 30));

// Reads: recent + report JSON (the hosted pages fetch these on every view).
export const readRateLimiter = makeRateLimiter(perMinute("RATE_LIMIT_READS_PER_MIN", 120));
