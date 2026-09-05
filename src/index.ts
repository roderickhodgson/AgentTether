import "dotenv/config";
import express from "express";
import { prisma } from "./db.js";
import { logger } from "./logger.js";
import { intentsRouter } from "./api/intentsRouter.js";
import { mountOneshot } from "./api/oneshot.js";
import { startSubstreams } from "./dataplane/substreamsManager.js";
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
await startSettlementSweeps();
startSubstreams().catch((e) => {
  logger.error({ err: e instanceof Error ? e.message : e }, "substreams stream unavailable — API continues without it");
});
