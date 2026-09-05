import { PrismaClient, IntentStatus, Prisma } from "@prisma/client";

export const prisma = new PrismaClient();

export type IntentStatusValue = IntentStatus;

export type CreateIntentInput = {
  agentWallet: string;
  targetContract: string;
  ttlTimestamp: Date;
  maxLimitAtomic: string;
  ratePerEventAtomic: string;
  eventCondition: Prisma.InputJsonValue;
  webhookUrl?: string;
};

export async function createIntent(input: CreateIntentInput) {
  return prisma.intent.create({
    data: { ...input, status: "PENDING_PAYMENT" },
  });
}

export async function getIntent(id: string) {
  return prisma.intent.findUnique({ where: { id } });
}

export async function getIntentByPaymentNonce(nonce: string) {
  return prisma.intent.findUnique({ where: { paymentNonce: nonce } });
}

export async function storeVerifiedPayment(
  id: string,
  paymentNonce: string,
  paymentPayload: Prisma.InputJsonValue,
  agentWallet?: string,
) {
  return prisma.intent.update({
    where: { id },
    data: {
      paymentNonce,
      paymentPayload,
      status: "MONITORING",
      ...(agentWallet ? { agentWallet } : {}),
    },
  });
}

export async function updateIntentStatus(id: string, status: IntentStatus) {
  return prisma.intent.update({ where: { id }, data: { status } });
}

export async function incrementEventsMatched(id: string, by = 1) {
  return prisma.intent.update({
    where: { id },
    data: { eventsMatched: { increment: by } },
  });
}

// Atomic per-block metering: increments every intent in the map and advances the stream
// cursor in ONE transaction. A crash mid-block rolls both back, so the restart replays
// the block cleanly — the cursor never advances past un-metered matches.
export async function meterAndCommit(
  byIntent: Map<string, number>,
  cursor: string,
  blockNum: number,
) {
  return prisma.$transaction(async (tx) => {
    const totals = new Map<string, number>();
    for (const [intentId, count] of byIntent) {
      const updated = await tx.intent.update({
        where: { id: intentId },
        data: { eventsMatched: { increment: count } },
      });
      totals.set(intentId, updated.eventsMatched);
    }
    await tx.substreamsCursor.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", cursor, blockNum },
      update: { cursor, blockNum },
    });
    return totals;
  });
}

export async function getMonitoringIntents() {
  return prisma.intent.findMany({ where: { status: "MONITORING" } });
}

export async function getExpiredMonitoringIntents(now = new Date()) {
  return prisma.intent.findMany({
    where: { status: "MONITORING", ttlTimestamp: { lt: now } },
  });
}

export async function getCursor() {
  return prisma.substreamsCursor.findUnique({ where: { id: "singleton" } });
}

export async function saveCursor(cursor: string, blockNum: number) {
  return prisma.substreamsCursor.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", cursor, blockNum },
    update: { cursor, blockNum },
  });
}

export async function clearCursor() {
  await prisma.substreamsCursor.deleteMany({});
}
