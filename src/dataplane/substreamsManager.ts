/**
 * Data plane: live Substreams consumer (the docs' "Direct Streaming" pattern).
 *
 * Streams the vendored ERC-20 transfers package from a hosted Substreams endpoint,
 * matches each block's transfers against active MONITORING intents (contract + min
 * amount + the intent's [createdAt, ttlTimestamp] window), meters matches into
 * `events_matched`, persists the stream cursor to
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
import { meterAndCommit, type CaptureTransferInput } from "../db.js";
import { executeSuccessSettlement } from "../payments/settlementEngine.js";
import { oneshotContracts } from "../payments/pricing.js";
import { logger } from "../logger.js";

// Data-plane config (defaults mirrored in .env.example) — independent of the payment plane.
const ENDPOINT = process.env.SUBSTREAMS_ENDPOINT ?? "https://mainnet.eth.streamingfast.io:443";
const SPKG = process.env.SUBSTREAMS_SPKG ?? "vendor/erc20Transfers-v0.1.4.spkg";
const OUTPUT_MODULE = process.env.SUBSTREAMS_MODULE ?? "map_transfers";
const API_KEY = process.env.SUBSTREAMS_API_KEY ?? "";

const RESTART_HEAD_OFFSET = -12; // fresh-start position: 12 blocks behind head (negative = relative)
const MAX_BACKOFF_MS = 30_000; // reconnect backoff ceiling
const MAX_EMPTY_ATTEMPTS = 5; // consecutive no-data attempts before giving up (auth/endpoint failure guard)
const HEARTBEAT_BLOCKS = 50n; // sampled progress log: at least this many blocks...
const HEARTBEAT_MS = 30_000; // ...or this much wall time, whichever comes first

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

// The per-transfer matching predicate (extracted for the test suite — it encodes the
// 2.3 window semantics). `blockTime === null` means the block carried no usable
// timestamp, which leaves BOTH time guards open (the designed fail-open default: an
// absent clock never silently disqualifies matches). A malformed minAmount disables
// matching for the intent rather than crashing the stream.
//
// Selectors (generalized): an intent watches EITHER an asset (targetContract + optional
// minAmount — the legacy form) OR a wallet (watchWallet + direction: the transfer must
// touch the wallet on the watched side). Both together = "this asset, involving this
// wallet". minAmount defaults to 0 (any transfer of the watched asset); the router
// enforces that at least one selector is present — the matcher fails closed on neither.
export type MatchableIntent = {
  targetContract: string | null; // asset selector — optional when a wallet is watched
  watchWallet?: string | null; // wallet predicate (either side, per direction)
  direction?: string | null; // incoming | outgoing | any (default any)
  eventCondition: unknown; // { minAmount?: string }
  createdAt: Date;
  ttlTimestamp: Date;
};

export function matchesIntent(
  intent: MatchableIntent,
  transfer: { contract: string; from: string; to: string; value: string },
  blockTime: Date | null,
): boolean {
  if (blockTime) {
    // Window start guard: never meter events that predate the intent — a fresh intent
    // created during a downtime catch-up would otherwise match historical blocks.
    if (blockTime < intent.createdAt) return false;
    // Window end guard (TTL): never meter events for an intent whose window has closed.
    if (blockTime > intent.ttlTimestamp) return false;
  }
  // Asset selector: only constrains when the intent names a contract.
  if (intent.targetContract && normalizeHex(transfer.contract) !== normalizeHex(intent.targetContract)) {
    return false;
  }
  // Wallet selector + direction. Without a wallet AND without a contract the intent
  // selects nothing — fail closed (the router rejects such intents at creation).
  if (intent.watchWallet) {
    const wallet = normalizeHex(intent.watchWallet);
    const dir = intent.direction ?? "any";
    const incoming = normalizeHex(transfer.to) === wallet;
    const outgoing = normalizeHex(transfer.from) === wallet;
    if (dir === "incoming" && !incoming) return false;
    if (dir === "outgoing" && !outgoing) return false;
    if (dir === "any" && !incoming && !outgoing) return false;
  } else if (!intent.targetContract) {
    return false;
  }
  // Amount gate: optional — 0 (or absent/blank) means any transfer of the watched asset.
  const minAmount = ((intent.eventCondition as { minAmount?: string } | null)?.minAmount ?? "").trim() || "0";
  try {
    if (BigInt(transfer.value) < BigInt(minAmount)) return false;
  } catch {
    return false;
  }
  return true;
}

function blockTimestamp(clock: Clock): string {
  const ts = clock.timestamp;
  return ts?.seconds != null ? new Date(Number(ts.seconds) * 1000).toISOString() : "";
}

// Sampled progress heartbeat: the lag signal is chain-time-vs-wall-clock — seconds during
// live tail, hours during catch-up. (ModulesProgress carries no usable head block.)
// When the stream's Clock carries no timestamp, lag is UNKNOWN — reporting 0.0 there
// masked a real stall once (the 2026-09-07 incident), so it now says so explicitly.
let blocksSinceHeartbeat = 0n;
let lastHeartbeatAt = 0;
let undoCount = 0;

function heartbeat(clock: Clock) {
  blocksSinceHeartbeat += 1n;
  lastStreamActivity = Date.now();
  const now = Date.now();
  if (blocksSinceHeartbeat < HEARTBEAT_BLOCKS && now - lastHeartbeatAt < HEARTBEAT_MS) return;
  blocksSinceHeartbeat = 0n;
  lastHeartbeatAt = now;
  const chainMs = Number(clock.timestamp?.seconds ?? 0n) * 1000;
  if (!chainMs) {
    logger.info(
      { block: clock.number.toString(), behindWallClockMin: null, undosSoFar: undoCount },
      `stream progress: block ${clock.number} · lag unknown (no clock timestamp)`,
    );
    return;
  }
  const behindMin = (now - chainMs) / 60000;
  logger.info(
    { block: clock.number.toString(), chainTime: new Date(chainMs).toISOString(), behindWallClockMin: Number(behindMin.toFixed(1)), undosSoFar: undoCount },
    `stream progress: block ${clock.number} · ${behindMin.toFixed(1)} min behind wall clock`,
  );
}

// ── Stall watchdog ──────────────────────────────────────────────────────────
// A hung endpoint delivers no blocks, no close, no error — runStream's await just
// parks (observed live: 2.5h of silence while test intents expired unbilled). The
// watchdog treats "no stream activity for STALL_MS" as a dead connection and stops
// the current handle, so the manager's retry loop reconnects. Activity = any block
// or undo signal.
const STALL_MS = Number(process.env.SUBSTREAMS_STALL_MS ?? 3 * 60_000);
let lastStreamActivity = Date.now();
let stallTimer: NodeJS.Timeout | null = null;

function startStallWatchdog() {
  if (stallTimer) return;
  stallTimer = setInterval(() => {
    const idleMs = Date.now() - lastStreamActivity;
    if (idleMs <= STALL_MS) return;
    const current = currentStream;
    if (!current) return; // between attempts — the retry loop's backoff covers this
    logger.warn(
      { idleMs: Math.round(idleMs / 1000), stallLimitS: Math.round(STALL_MS / 1000), undosSoFar: undoCount },
      `stream stalled — no activity for ${Math.round(idleMs / 1000)}s, forcing reconnect`,
    );
    lastStreamActivity = Date.now(); // re-arm; the retry loop logs the reconnect
    try {
      current.stop();
    } catch (e) {
      logger.error({ err: e instanceof Error ? e.message : e }, "stall watchdog stop failed");
    }
  }, 15_000);
  stallTimer.unref();
}

// Oneshot capture (3.4): every allowlisted transfer in the block, independent of intent
// matches — the pull endpoint queries history, so capture must run even with zero
// monitoring intents. Written per block inside the same transaction as metering.
function captureTransfers(message: JsonObject | undefined, clock: Clock): CaptureTransferInput[] {
  const allow = oneshotContracts();
  if (allow.length === 0) return [];
  const transfers = (message as { transfers?: TransferEvent[] } | undefined)?.transfers ?? [];
  const chain = process.env.DATA_CHAIN ?? "ethereum-mainnet";
  const ts = new Date(blockTimestamp(clock));
  // Capture rows carry the canonical 0x-prefixed form (public API surface — the oneshot
  // responses and its allowlist comparisons are web3-shaped, unlike the internal
  // matched-events webhook payload which keeps the bare-hex convention).
  const hex = (h: string) => `0x${normalizeHex(h)}`;
  const out: CaptureTransferInput[] = [];
  for (const t of transfers) {
    const contract = hex(t.contract);
    if (!allow.includes(contract.toLowerCase())) continue;
    let amount: bigint;
    try {
      amount = BigInt(t.value);
    } catch {
      continue; // unparseable value — capture skips it, metering is unaffected
    }
    out.push({
      chain,
      blockNum: clock.number,
      blockTimestamp: Number.isNaN(ts.getTime()) ? new Date(0) : ts,
      txHash: hex(t.txId),
      logIndex: Number(t.blockIndex ?? 0),
      contract,
      from: hex(t.from),
      to: hex(t.to),
      amount,
    });
  }
  return out;
}

async function matchTransfers(message: JsonObject | undefined, clock: Clock): Promise<NormalizedEvent[]> {
  const { getMonitoringIntents, setStartBlockNum } = await import("../db.js");
  const intents = await getMonitoringIntents();
  if (intents.length === 0) return [];

  // Block time comes from the stream's Clock (not the events) and drives the TTL guard:
  // during downtime catch-up, replayed blocks that postdate an intent's ttl_timestamp
  // must not meter. An absent timestamp leaves the guard open (safe default).
  const blockTime = new Date(blockTimestamp(clock));
  const blockTimeValid = !Number.isNaN(blockTime.getTime());

  // Per-block billing starts at the FIRST in-window block the stream processes: lazily
  // backfill startBlockNum here. During a catch-up replay this deliberately defers
  // until the replay reaches the intent's creation time — pre-creation blocks are
  // never billed (the matcher skips them anyway; this keeps the bill symmetric with
  // the matching window).
  for (const intent of intents) {
    if (intent.startBlockNum == null && blockTimeValid && blockTime >= intent.createdAt) {
      const blockNum = Number(clock.number);
      await setStartBlockNum(intent.id, blockNum);
      logger.info({ intent: intent.id, startBlockNum: blockNum }, "billing window opened — start block set");
    }
  }

  const transfers = (message as { transfers?: TransferEvent[] } | undefined)?.transfers ?? [];
  const out: NormalizedEvent[] = [];
  for (const t of transfers) {
    for (const intent of intents) {
      // Time guards live in matchesIntent: an absent/invalid block timestamp passes
      // null, which leaves both guards open (fail-open by design, see above).
      if (!matchesIntent(intent, t, blockTimeValid ? blockTime : null)) continue;
      // Block-budget guard: the window ends when the quoted blocks are consumed —
      // whichever runs out first (this or the TTL). Replayed catch-up blocks past the
      // budget are skipped too, so catch-up work stops at the paid boundary.
      if (
        intent.startBlockNum != null &&
        Number(clock.number) >= intent.startBlockNum + intent.budgetBlocks
      ) {
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
    logger.info({ traceId: session.traceId, resolvedStart: session.resolvedStartBlock.toString() }, "session started");
  });
  emitter.on("anyMessage", (message, cursor, clock) => {
    blocksSeen += 1;
    state.lastCursor = cursor;
    heartbeat(clock);
    writeChain = writeChain
      .then(() => onBlock(message, cursor, clock))
      .catch((e) => logger.error({ err: e }, "onBlock failed"));
  });
  emitter.on("undo", (undo) => {
    // Chain reorg: resume from the last valid block. Metered counters are NOT rolled
    // back (demo-adequate — an undoed match may leave an off-by-one in events_matched).
    logger.warn({ lastValidCursor: undo.lastValidCursor.slice(0, 24), undoNumber: ++undoCount }, "undo signal — reverting cursor to last valid block");
    lastStreamActivity = Date.now();
    state.lastCursor = undo.lastValidCursor;
    writeChain = writeChain
      .then(() => saveCursor(undo.lastValidCursor, 0n))
      // Oneshot capture rows from the undone blocks would sit above the reverted cursor
      // and pollute the lookback window — prune them (the replay re-captures).
      .then(async () => {
        const { getCursor, pruneCapturesAboveBlock } = await import("../db.js");
        const row = await getCursor();
        if (row) await pruneCapturesAboveBlock(row.blockNum);
      })
      .catch((e) => logger.error({ err: e }, "undo cursor save failed"));
  });
  emitter.on("close", (error) => {
    emitter.stop();
    if (error) logger.warn({ err: error.message }, "stream closed");
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

// Graceful-stop coordination: shutdown handlers call stopSubstreams(), which stops the
// active stream handle and breaks the manager's retry loop. In-flight per-block writes
// finish on their own chains (cursor-committed blocks are safe; the rest replay).
let stopping = false;
let currentStream: { stop(): void } | null = null;

export function stopSubstreams(): void {
  stopping = true;
  currentStream?.stop();
}

export async function startSubstreams(): Promise<void> {
  if (!API_KEY) throw new Error("SUBSTREAMS_API_KEY is required");
  // Single-writer lease: claim BEFORE the retry loop. A fresh lease held by another
  // instance throws LeaseHeldError — the entrypoint hard-exits so a supervisor keeps
  // retrying until the dead holder's lease goes stale and this instance takes over.
  const { acquireLease } = await import("../lease.js");
  await acquireLease();
  startStallWatchdog();
  const state: StreamState = { lastCursor: (await getSavedCursor()) ?? undefined };
  logger.info(
    {
      module: OUTPUT_MODULE,
      endpoint: ENDPOINT,
      spkg: SPKG,
      cursor: state.lastCursor ? `resume ${state.lastCursor.slice(0, 24)}…` : `fresh start (${RESTART_HEAD_OFFSET} from head)`,
    },
    "substreams manager starting",
  );

  let backoffMs = 1000;
  let emptyAttempts = 0;
  let failuresOnCursor = 0;
  for (;;) {
    if (stopping) return;
    const resuming = Boolean(state.lastCursor);
    try {
      let blocksSeen = 0;
      const handle = await runStream(state, async (message, cursor, clock) => {
        blocksSeen += 1;
        const matches = await matchTransfers(message, clock);
        for (const e of matches) {
          logger.debug(
            {
              intent: e.intentId,
              block: e.block.toString(),
              logIndex: e.logIndex,
              amount: e.amount,
              tx: e.txHash,
              chainTime: e.blockTimestamp,
            },
            "match",
          );
        }
        const byIntent = new Map<string, number>();
        // Batch one UPDATE per intent per block — a downtime catch-up can carry ~150k
        // matches, and per-match writes would serialize into minutes of lag.
        for (const e of matches) byIntent.set(e.intentId, (byIntent.get(e.intentId) ?? 0) + 1);
        const capture = captureTransfers(message, clock);
        if (byIntent.size === 0 && capture.length === 0) {
          await saveCursor(cursor, clock.number);
          return;
        }
        // Atomic per block: metering (+ bounded event capture + oneshot capture) and the
        // cursor commit or roll back together — a crash mid-block replays the block
        // cleanly on restart instead of double-metering.
        const metered = await meterAndCommit(byIntent, matches, cursor, Number(clock.number), capture);
        for (const [intentId, count] of byIntent) {
          const total = metered.get(intentId) ?? 0;
          // Settlement engine fires strictly AFTER the commit (external side effects
          // can't live inside the transaction), exactly once per intent: only when this
          // block crossed the counter from zero (total - count === 0). The engine's CAS
          // claim makes a lost-then-swept trigger safe either way (4.3's startup sweep).
          if (total - count === 0) await executeSuccessSettlement(intentId);
          logger.debug(
            { intent: intentId, metered: count, eventsMatched: total },
            "metered block matches",
          );
        }
      });
      currentStream = handle;
      const result = await handle.done;
      currentStream = null;
      blocksSeen = result.blocksSeen;
      backoffMs = 1000;
      failuresOnCursor = 0;
      emptyAttempts = blocksSeen > 0 ? 0 : emptyAttempts + 1;
      if (emptyAttempts >= MAX_EMPTY_ATTEMPTS) {
        throw new Error(`${MAX_EMPTY_ATTEMPTS} consecutive attempts with no blocks — giving up`);
      }
      logger.info({ blocksSeen }, `stream ended after ${blocksSeen} blocks — retrying in ${backoffMs}ms`);
    } catch (e) {
      currentStream = null;
      if (stopping) return;
      emptyAttempts += 1;
      if (resuming) {
        failuresOnCursor += 1;
        // A cursor is bound to the module hash — a spkg upgrade invalidates it. After
        // repeated resume failures, fall back to a head start (misses downtime events;
        // that is the correct recovery for an upgraded package).
        if (failuresOnCursor >= 3) {
          logger.warn("resume keeps failing — wiping cursor and restarting from head");
          await clearCursor();
          state.lastCursor = undefined;
          failuresOnCursor = 0;
        }
      }
      if (emptyAttempts >= MAX_EMPTY_ATTEMPTS) {
        throw e;
      }
      logger.warn({ err: e instanceof Error ? e.message : e }, `stream attempt failed — retrying in ${backoffMs}ms`);
    }
    await sleep(backoffMs);
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
  }
}

async function getSavedCursor() {
  const { getCursor } = await import("../db.js");
  const row = await getCursor();
  return row?.cursor ?? null;
}

async function saveCursor(cursor: string, blockNum: bigint) {
  const { saveCursor: persist } = await import("../db.js");
  await persist(cursor, Number(blockNum));
}

async function clearCursor() {
  const { clearCursor: wipe } = await import("../db.js");
  await wipe();
}

// Standalone entrypoint (`npm run stream`); the Express server calls startSubstreams().
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  startSubstreams().catch((e) => {
    logger.error({ err: e instanceof Error ? e.message : e }, "substreams manager exited");
    process.exit(1);
  });
}
