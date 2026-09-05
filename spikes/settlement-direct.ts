/**
 * Direct-drive check for the settlement engine (Phase 4.2 verification) — runs the
 * engine functions against REAL intents so actual money moves before the cron layer
 * (step C) exists:
 *
 *  - no args: list MONITORING candidates (id, events, voucher kind, expiry)
 *  - `timeout <id>`: settle an expired real-voucher intent via the timeout path, then
 *    immediately re-drive it to prove the CAS/status guard no-ops on the second call
 *  - `success <id>`: drive the success path (use a fixture-* voucher intent for the
 *    free negative test: the facilitator must reject and the intent lands SETTLE_FAILED)
 *
 * Read-only on chain except through the engine; all state changes go through the
 * engine's CAS claim, so this spike cannot double-settle anything.
 */
import "dotenv/config";
import { prisma } from "../src/db.js";
import { executeSuccessSettlement, executeTimeoutSettlement } from "../src/payments/settlementEngine.js";

const [mode, targetId] = process.argv.slice(2);

if (!mode) {
  const candidates = await prisma.intent.findMany({ where: { status: "MONITORING" } });
  for (const c of candidates) {
    const kind = c.paymentNonce?.startsWith("fixture-") ? "SYNTHETIC" : "real";
    console.log(
      `${c.id} · events=${c.eventsMatched} · ${kind} voucher · ${c.ttlTimestamp < new Date() ? "EXPIRED" : "in-TTL"} · webhook=${c.webhookUrl ?? "none"}`,
    );
  }
  process.exit(0);
}

if (!targetId) {
  console.error("mode requires an intent id");
  process.exit(1);
}

if (mode === "timeout") {
  await executeTimeoutSettlement(targetId);
  const after = await prisma.intent.findUnique({ where: { id: targetId } });
  console.log("after first drive:", after?.status, "| tx:", after?.settlementTxHash, "| amount:", after?.settledAmountAtomic);
  await executeTimeoutSettlement(targetId); // must no-op — no longer claimable
  const afterRedrive = await prisma.intent.findUnique({ where: { id: targetId } });
  console.log("after re-drive (CAS no-op check):", afterRedrive?.status, "| tx unchanged:", afterRedrive?.settlementTxHash === after?.settlementTxHash);
} else if (mode === "success") {
  await executeSuccessSettlement(targetId);
  const after = await prisma.intent.findUnique({ where: { id: targetId } });
  console.log("after success drive:", after?.status, "| tx:", after?.settlementTxHash, "| amount:", after?.settledAmountAtomic);
} else {
  console.error("unknown mode — use: timeout <id> | success <id>");
  process.exit(1);
}

await prisma.$disconnect();
