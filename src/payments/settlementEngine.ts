import { prisma } from "../db.js";
import { logger } from "../logger.js";

export async function onEventsMatched(intentId: string): Promise<void> {
  const intent = await prisma.intent.findUnique({ where: { id: intentId } });
  if (!intent) return;
  logger.info(
    { intent: intentId, eventsMatched: intent.eventsMatched },
    `settlement engine (stub): intent has ${intent.eventsMatched} matched event(s) — deferred settle lands in Phase 4`,
  );
}
