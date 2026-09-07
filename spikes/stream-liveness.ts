/**
 * Stream-liveness gate: fails (exit 1) when the data plane's cursor is stale.
 *
 * The cursor row is written per processed block (12s cadence on mainnet), so a row
 * older than the threshold means the stream is stalled — exactly the silent-hang mode
 * the stall watchdog now recovers from, and the condition that produced a day of
 * zero-processed-block intents (Sep 7 incident: the narration said "charged ?" and
 * every test watch expired unbilled).
 *
 * Runs as the FIRST step of `npm run verify:live`, or standalone:
 *   tsx spikes/stream-liveness.ts [max_age_seconds]
 */
import "dotenv/config";

const MAX_AGE_S = Number(process.argv[2] ?? process.env.STREAM_LIVENESS_MAX_S ?? 180);

const { prisma } = await import("../src/db.js");

const row = await prisma.substreamsCursor.findUnique({ where: { id: "singleton" } });
if (!row) {
  console.error(`stream liveness: FAIL — no cursor row (the stream has never started)`);
  process.exit(1);
}
const ageS = Math.round((Date.now() - row.updatedAt.getTime()) / 1000);
if (ageS > MAX_AGE_S) {
  console.error(
    `stream liveness: FAIL — cursor is ${ageS}s stale (limit ${MAX_AGE_S}s, block ${row.blockNum}). ` +
      `The data plane is stalled; restart the backend (launchctl bootout/load or npm start) and retry.`,
  );
  process.exit(1);
}
console.log(`stream liveness: OK — block ${row.blockNum}, cursor ${ageS}s old (limit ${MAX_AGE_S}s)`);
process.exit(0);
