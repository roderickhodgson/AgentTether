import "dotenv/config";
import express from "express";
import { prisma } from "./db.js";
import { logger } from "./logger.js";
import { intentsRouter } from "./api/intentsRouter.js";
import { mountOneshot } from "./api/oneshot.js";
import { startSubstreams, stopSubstreams } from "./dataplane/substreamsManager.js";
import { isLeaseHeldError, releaseLease } from "./lease.js";
import { startSettlementSweeps } from "./cron.js";

const app = express();
app.use(express.json());
// Order matters: the intents router (including the middleware-bypassing /stream route)
// answers before the oneshot payment middleware sees the request; the oneshot handler
// sits AFTER the middleware so it only runs on verified payment.
app.use(intentsRouter);
await mountOneshot(app);

app.get("/healthz", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, db: "up" });
  } catch {
    res.status(503).json({ ok: false, db: "down" });
  }
});

const port = Number(process.env.PORT ?? 8080);
app.listen(port, () => {
  logger.info(`AgentTether backend listening on :${port}`);
});

// The data plane lives inside the Express process (2.1: one long-lived stream serves
// all intents). Sweeps run first (4.3: settle what downtime left behind BEFORE the
// stream starts); the stream then starts alongside the API — a stream failure logs and
// retries via the manager's own loop, and a missing API key degrades to API-only.
// A HELD STREAM LEASE is different: another instance owns the stream, so this process
// hard-exits and the supervisor keeps retrying until the dead holder's lease goes
// stale — a crashed streamer is always replaced by a live streamer, never by a silent
// API-only zombie.
await startSettlementSweeps();
startSubstreams().catch((e) => {
  if (isLeaseHeldError(e)) {
    logger.error({ err: e.message, heldBy: e.heldBy }, "single-writer lease held by another instance — exiting");
    process.exit(1);
  }
  logger.error({ err: e instanceof Error ? e.message : e }, "substreams stream unavailable — API continues without it");
});

// Graceful shutdown: stop the stream, release the single-writer lease (a supervisor
// restart takes over immediately — no TTL wait), close the pool.
let shuttingDown = false;
async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down");
  stopSubstreams();
  await releaseLease();
  await prisma.$disconnect();
  process.exit(0);
}
process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
