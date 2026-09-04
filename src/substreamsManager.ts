/**
 * Data plane: live Substreams consumer (the docs' "Direct Streaming" pattern).
 *
 * Streams the vendored ERC-20 transfers package from a hosted Substreams endpoint,
 * matches each block's transfers against active MONITORING intents (contract + min
 * amount + TTL), meters matches into `events_matched`, persists the stream cursor to
 * Postgres for crash/resume safety, and hands each intent's first match to the
 * settlement engine. Runs standalone (`npm run stream`) or via `startSubstreams()`
 * from the Express entrypoint.
 */
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { readPackageFromFile } from "@substreams/manifest";
import { createRegistry, createRequest } from "@substreams/core";
import type { Clock } from "@substreams/core/proto";
import type { JsonObject } from "@bufbuild/protobuf";
import { BlockEmitter } from "@substreams/node";
import { createNodeTransport } from "@substreams/node/createNodeTransport";
import { meterAndCommit } from "./db.js";
import { onEventsMatched } from "./settlementEngine.js";

// Data-plane config (defaults mirrored in .env.example) — independent of the payment plane.
const ENDPOINT = process.env.SUBSTREAMS_ENDPOINT ?? "https://mainnet.eth.streamingfast.io:443";
const SPKG = process.env.SUBSTREAMS_SPKG ?? "vendor/erc20Transfers-v0.1.4.spkg";
const OUTPUT_MODULE = process.env.SUBSTREAMS_MODULE ?? "map_transfers";
const API_KEY = process.env.SUBSTREAMS_API_KEY ?? "";

const RESTART_HEAD_OFFSET = -12; // fresh-start position: 12 blocks behind head (negative = relative)
const MAX_BACKOFF_MS = 30_000; // reconnect backoff ceiling
const MAX_EMPTY_ATTEMPTS = 5; // consecutive no-data attempts before giving up (auth/endpoint failure guard)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type StreamHandle = { stop: () => void; done: Promise<{ blocksSeen: number }> };
// Shared mutable state: `lastCursor` is updated synchronously in stream event handlers,
// so a restart always resumes from the newest block even while DB writes are still in flight.
type StreamState = { lastCursor?: string };

// Wire shape of `erc20.types.v1.TransferEvent` from the vendored Pinax spkg. Hex fields
// arrive lowercase without a `0x` prefix; uint64 fields decode as strings in JSON.
type TransferEvent = {
  contract: string;
  from: string;
  to: string;
  value: string;
  txId: string;
  blockIndex: string;
  index: number;
};

type NormalizedEvent = {
  intentId: string;
  chain: string;
  block: bigint;
  blockTimestamp: string;
  txHash: string;
  logIndex: number;
  contract: string;
  from: string;
  to: string;
  amount: string;
};

const normalizeHex = (h: string) => h.toLowerCase().replace(/^0x/, "");

function blockTimestamp(clock: Clock): string {
  const ts = clock.timestamp;
  return ts?.seconds != null ? new Date(Number(ts.seconds) * 1000).toISOString() : "";
}

async function matchTransfers(message: JsonObject | undefined, clock: Clock): Promise<NormalizedEvent[]> {
  const { getMonitoringIntents } = await import("./db.js");
  const intents = await getMonitoringIntents();
  if (intents.length === 0) return [];

  // Block time comes from the stream's Clock (not the events) and drives the TTL guard:
  // during downtime catch-up, replayed blocks that postdate an intent's ttl_timestamp
  // must not meter. An absent timestamp leaves the guard open (safe default).
  const blockTime = new Date(blockTimestamp(clock));
  const blockTimeValid = !Number.isNaN(blockTime.getTime());

  const transfers = (message as { transfers?: TransferEvent[] } | undefined)?.transfers ?? [];
  const out: NormalizedEvent[] = [];
  for (const t of transfers) {
    for (const intent of intents) {
      // TTL guard: never meter events for an intent whose window has closed.
      if (blockTimeValid && blockTime > intent.ttlTimestamp) continue;
      if (normalizeHex(t.contract) !== normalizeHex(intent.targetContract)) continue;
      const minAmount = (intent.eventCondition as { minAmount?: string } | null)?.minAmount;
      if (!minAmount) continue;
      // minAmount is a string in atomic units; a malformed value disables matching
      // for the intent rather than crashing the stream.
      try {
        if (BigInt(t.value) < BigInt(minAmount)) continue;
      } catch {
        continue;
      }
      out.push({
        intentId: intent.id,
        chain: process.env.DATA_CHAIN ?? "ethereum-mainnet",
        block: clock.number,
        blockTimestamp: blockTimestamp(clock),
        txHash: normalizeHex(t.txId),
        logIndex: Number(t.blockIndex ?? 0),
        contract: normalizeHex(t.contract),
        from: normalizeHex(t.from),
        to: normalizeHex(t.to),
        amount: t.value,
      });
    }
  }
  return out;
}

async function runStream(
  state: StreamState,
  onBlock: (message: JsonObject | undefined, cursor: string, clock: Clock) => Promise<void>,
): Promise<StreamHandle> {
  const pkg = await readPackageFromFile(SPKG);
  const registry = createRegistry(pkg);
  const request = createRequest({
    substreamPackage: pkg,
    outputModule: OUTPUT_MODULE,
    productionMode: true,
    // finalBlocksOnly delays first delivery by up to ~13 min on Ethereum (finality), so
    // head streaming is the default; undo signals (below) cover the tiny reorg window.
    finalBlocksOnly: process.env.SUBSTREAMS_FINAL_BLOCKS_ONLY === "true",
    ...(state.lastCursor ? { startCursor: state.lastCursor } : { startBlockNum: RESTART_HEAD_OFFSET }),
  });
  const headers = new Headers({ "X-User-Agent": "agenttether", "X-Api-Key": API_KEY });
  const transport = createNodeTransport(ENDPOINT, API_KEY, registry, headers);
  const emitter = new BlockEmitter(transport, request, registry);

  let blocksSeen = 0;
  let resolveDone!: (v: { blocksSeen: number }) => void;
  let rejectDone!: (e: Error) => void;
  const done = new Promise<{ blocksSeen: number }>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });

  // Serialized write queue: cursor + metering writes must complete in block order, or an
  // out-of-order flush could persist an older cursor (→ duplicate processing after a
  // restart). `close` drains the chain before resolving, so no write is lost mid-restart.
  let writeChain = Promise.resolve();

  emitter.on("session", (session) => {
    console.log(`session: traceId=${session.traceId} resolvedStart=${session.resolvedStartBlock}`);
  });
  emitter.on("progress", (p) => {
    if (process.env.DEBUG_STREAM) console.log(`progress: ${JSON.stringify(p.toJson())}`);
  });
  emitter.on("anyMessage", (message, cursor, clock) => {
    blocksSeen += 1;
    state.lastCursor = cursor;
    writeChain = writeChain
      .then(() => onBlock(message, cursor, clock))
      .catch((e) => console.error("onBlock failed:", e));
  });
  emitter.on("undo", (undo) => {
    // Chain reorg: resume from the last valid block. Metered counters are NOT rolled
    // back (demo-adequate — an undoed match may leave an off-by-one in events_matched).
    console.log(`undo signal — reverting cursor to last valid block`);
    state.lastCursor = undo.lastValidCursor;
    writeChain = writeChain
      .then(() => saveCursor(undo.lastValidCursor, 0n))
      .catch((e) => console.error("undo cursor save failed:", e));
  });
  emitter.on("close", (error) => {
    emitter.stop();
    if (error) console.error("stream closed:", error.message);
    writeChain.then(() => resolveDone({ blocksSeen }));
  });
  emitter.on("fatalError", (error) => {
    emitter.stop();
    const msg = (error as unknown as { message?: string }).message ?? String(error);
    rejectDone(new Error(`fatal: ${msg}`));
  });

  const stop = emitter.start();
  return {
    stop: () => {
      emitter.stop();
      stop();
    },
    done,
  };
}

export async function startSubstreams(): Promise<never> {
  if (!API_KEY) throw new Error("SUBSTREAMS_API_KEY is required");
  const state: StreamState = { lastCursor: (await getSavedCursor()) ?? undefined };
  console.log(
    `substreams: module=${OUTPUT_MODULE} endpoint=${ENDPOINT}\n  spkg: ${SPKG}\n  cursor: ${state.lastCursor ? `resume ${state.lastCursor.slice(0, 24)}…` : `fresh start (${RESTART_HEAD_OFFSET} from head)`}`,
  );

  let backoffMs = 1000;
  let emptyAttempts = 0;
  let failuresOnCursor = 0;
  for (;;) {
    const resuming = Boolean(state.lastCursor);
    try {
      let blocksSeen = 0;
      const handle = await runStream(state, async (message, cursor, clock) => {
        blocksSeen += 1;
        const matches = await matchTransfers(message, clock);
        for (const e of matches) {
          console.log(
            `MATCH intent ${e.intentId.slice(0, 8)}… block ${e.block} · log ${e.logIndex} · amount ${e.amount} · tx ${e.txHash.slice(0, 14)}… · ${e.blockTimestamp}`,
          );
        }
        const byIntent = new Map<string, number>();
        // Batch one UPDATE per intent per block — a downtime catch-up can carry ~150k
        // matches, and per-match writes would serialize into minutes of lag.
        for (const e of matches) byIntent.set(e.intentId, (byIntent.get(e.intentId) ?? 0) + 1);
        if (byIntent.size === 0) {
          await saveCursor(cursor, clock.number);
          return;
        }
        // Atomic per block: metering and cursor commit or roll back together — a crash
        // mid-block replays the block cleanly on restart instead of double-metering.
        const metered = await meterAndCommit(byIntent, cursor, Number(clock.number));
        for (const [intentId, count] of byIntent) {
          const total = metered.get(intentId) ?? 0;
          // Settlement engine fires strictly AFTER the commit (external side effects
          // can't live inside the transaction), exactly once per intent: only when this
          // block crossed the counter from zero (total - count === 0).
          if (total - count === 0) await onEventsMatched(intentId);
          console.log(
            `metered ${count} match(es) for intent ${intentId.slice(0, 8)}… → events_matched=${total}`,
          );
        }
      });
      const result = await handle.done;
      blocksSeen = result.blocksSeen;
      backoffMs = 1000;
      failuresOnCursor = 0;
      emptyAttempts = blocksSeen > 0 ? 0 : emptyAttempts + 1;
      if (emptyAttempts >= MAX_EMPTY_ATTEMPTS) {
        throw new Error(`${MAX_EMPTY_ATTEMPTS} consecutive attempts with no blocks — giving up`);
      }
      console.log(`stream ended after ${blocksSeen} blocks — retrying in ${backoffMs}ms`);
    } catch (e) {
      emptyAttempts += 1;
      if (resuming) {
        failuresOnCursor += 1;
        // A cursor is bound to the module hash — a spkg upgrade invalidates it. After
        // repeated resume failures, fall back to a head start (misses downtime events;
        // that is the correct recovery for an upgraded package).
        if (failuresOnCursor >= 3) {
          console.error("resume keeps failing — wiping cursor and restarting from head");
          await clearCursor();
          state.lastCursor = undefined;
          failuresOnCursor = 0;
        }
      }
      if (emptyAttempts >= MAX_EMPTY_ATTEMPTS) {
        throw e;
      }
      console.error(`stream attempt failed (${e instanceof Error ? e.message : e}) — retrying in ${backoffMs}ms`);
    }
    await sleep(backoffMs);
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
  }
}

async function getSavedCursor() {
  const { getCursor } = await import("./db.js");
  const row = await getCursor();
  return row?.cursor ?? null;
}

async function saveCursor(cursor: string, blockNum: bigint) {
  const { saveCursor: persist } = await import("./db.js");
  await persist(cursor, Number(blockNum));
}

async function clearCursor() {
  const { clearCursor: wipe } = await import("./db.js");
  await wipe();
}

// Standalone entrypoint (`npm run stream`); the Express server calls startSubstreams().
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  startSubstreams().catch((e) => {
    console.error("substreams manager exited:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
