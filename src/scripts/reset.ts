/**
 * Demo reset: wipes ALL intents (regardless of TTL) and the stream cursor so the next
 * `npm run stream` starts fresh from ~12 blocks behind head. For demo/practice use when
 * past correctness doesn't matter — e.g. returning to the project after a long gap,
 * where a full catch-up replay would otherwise run for many minutes first.
 */
import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { prisma } from "../db.js";

const force = process.argv.includes("--force");
if (!force) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question("Delete ALL intents and the stream cursor? This cannot be undone. (y/N) ");
  rl.close();
  if (answer.trim().toLowerCase() !== "y") {
    console.log("aborted — nothing was deleted");
    process.exit(0);
  }
}

const intents = await prisma.intent.deleteMany({});
const cursor = await prisma.substreamsCursor.deleteMany({});
console.log(
  `reset complete: deleted ${intents.count} intent(s) and ${cursor.count} cursor row(s) — next stream starts fresh from head`,
);
await prisma.$disconnect();
