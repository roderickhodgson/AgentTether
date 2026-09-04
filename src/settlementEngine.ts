import { prisma } from "./db.js";

export async function onEventsMatched(intentId: string): Promise<void> {
  const intent = await prisma.intent.findUnique({ where: { id: intentId } });
  if (!intent) return;
  console.log(
    `settlement engine (stub): intent ${intentId} has ${intent.eventsMatched} matched event(s) — deferred settle lands in Phase 4`,
  );
}
