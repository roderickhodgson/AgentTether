/**
 * Phase 4.3 settlement sweeps: a node-cron minute pass plus the startup pass.
 *
 * The startup pass runs BEFORE the stream starts (wired in index.ts): downtime leaves
 * expired intents and lost settlement triggers behind, and the startup pass clears them
 * so catch-up metering begins from a clean settlement state. The minute pass then keeps
 * the deadline race won — voucher deadlines cover ttl + 120s, and a sweep every 60s
 * settles expired intents well inside that window. Only downtime longer than the buffer
 * voids a voucher (deadline-expired → TIMEOUT, uncollected — see the engine).
 */
import cron from "node-cron";
import { runSettlementSweep } from "./payments/settlementEngine.js";
import { pruneProcessedTransfers } from "./db.js";
import { oneshotRetentionHours } from "./payments/pricing.js";
import { logger } from "./logger.js";

async function maintenancePass(): Promise<void> {
  const pruned = await pruneProcessedTransfers(oneshotRetentionHours());
  if (pruned > 0) logger.info({ pruned }, "capture retention prune");
}

export async function startSettlementSweeps(): Promise<void> {
  try {
    const acted = await runSettlementSweep();
    logger.info({ acted }, "startup settlement sweep complete");
  } catch (e) {
    logger.error({ err: e instanceof Error ? e.message : e }, "startup settlement sweep failed — continuing (the minute cron will retry)");
  }
  try {
    await maintenancePass();
  } catch (e) {
    logger.error({ err: e instanceof Error ? e.message : e }, "startup capture prune failed — continuing (the minute cron will retry)");
  }

  const schedule = process.env.SETTLEMENT_SWEEP_CRON ?? "* * * * *";
  cron.schedule(schedule, () => {
    runSettlementSweep().catch((e) =>
      logger.error({ err: e instanceof Error ? e.message : e }, "settlement sweep pass failed"),
    );
    maintenancePass().catch((e) =>
      logger.error({ err: e instanceof Error ? e.message : e }, "capture prune pass failed"),
    );
  });
  logger.info({ schedule }, "settlement minute sweep scheduled");
}
