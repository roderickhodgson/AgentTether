import "dotenv/config";
import express from "express";
import { prisma } from "./db.js";
import { logger } from "./logger.js";

const app = express();
app.use(express.json());

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
