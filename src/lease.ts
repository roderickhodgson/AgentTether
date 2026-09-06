/**
 * Process-level single-writer lease (ops rule in code): exactly one backend instance
 * may stream against the DB. The dataplane claims the lease before streaming and holds
 * it via a 10s heartbeat; a crashed holder's lease goes stale after 30s and can be
 * taken over by a supervisor's restart. Losing the lease mid-run is fatal (hard exit,
 * per the runbook) — a supervisor retries until the stale lease expires and this
 * instance becomes the streamer, so a dead streamer is always replaced by a live one,
 * never by a silent API-only zombie.
 */
import { hostname } from "node:os";
import {
  claimProcessLease,
  releaseProcessLease,
  renewProcessLease,
} from "./db.js";
import { logger } from "./logger.js";

// Rich holder identity for unambiguous logs: which host, which pid, which boot.
export const PROCESS_HOLDER = `${hostname()}:${process.pid}:${new Date().toISOString()}`;

const HEARTBEAT_MS = 10_000;

// Typed error so the entrypoint can distinguish "another instance streams" (fatal,
// supervisor will retry) from ordinary stream failures (degrade to API-only).
export class LeaseHeldError extends Error {
  readonly heldBy: string;
  constructor(heldBy: string) {
    super(`stream lease held by another instance: ${heldBy}`);
    this.name = "LeaseHeldError";
    this.heldBy = heldBy;
  }
}

let heartbeatTimer: NodeJS.Timeout | null = null;

// Claim the lease or throw LeaseHeldError. Idempotent for this holder (re-claims
// refresh the heartbeat, so a supervisor restart of the SAME process identity still
// owns its lease).
export async function acquireLease(): Promise<void> {
  const ok = await claimProcessLease(PROCESS_HOLDER);
  if (!ok) {
    const { getProcessLease } = await import("./db.js");
    const lease = await getProcessLease();
    throw new LeaseHeldError(lease?.holder ?? "unknown");
  }
  logger.info({ holder: PROCESS_HOLDER }, "stream lease acquired — this instance is the single writer");
  startHeartbeat();
}

function startHeartbeat(intervalMs = HEARTBEAT_MS): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    renewProcessLease(PROCESS_HOLDER)
      .then((renewed) => {
        if (!renewed) {
          logger.error({ holder: PROCESS_HOLDER }, "stream lease lost mid-run — another instance took over; exiting");
          releaseLeaseBestEffort().finally(() => process.exit(1));
        }
      })
      .catch((e: unknown) => {
        // A DB blip must not kill a healthy streamer — the NEXT beat re-tries; three
        // consecutive misses make the lease claimable, which is the real backstop.
        logger.warn({ err: e instanceof Error ? e.message : e }, "lease heartbeat failed — retrying next beat");
      });
  }, intervalMs);
  // Don't hold the event loop open just for the heartbeat.
  heartbeatTimer.unref();
}

function releaseLeaseBestEffort(): Promise<void> {
  return releaseProcessLease(PROCESS_HOLDER).catch(() => {});
}

// Graceful shutdown path: stop the heartbeat and delete our row so a supervisor's
// restart takes over immediately (no TTL wait).
export async function releaseLease(): Promise<void> {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  try {
    await releaseProcessLease(PROCESS_HOLDER);
    logger.info({ holder: PROCESS_HOLDER }, "stream lease released");
  } catch (e) {
    logger.warn({ err: e instanceof Error ? e.message : e }, "lease release failed (row will go stale instead)");
  }
}

export function isLeaseHeldError(e: unknown): e is LeaseHeldError {
  return e instanceof LeaseHeldError;
}
