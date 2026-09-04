import "dotenv/config";
import { pathToFileURL } from "node:url";
import { readPackageFromFile } from "@substreams/manifest";
import { createRegistry, createRequest } from "@substreams/core";
import { BlockEmitter } from "@substreams/node";
import { createNodeTransport } from "@substreams/node/createNodeTransport";

const ENDPOINT = process.env.SUBSTREAMS_ENDPOINT ?? "https://mainnet.eth.streamingfast.io:443";
const SPKG = process.env.SUBSTREAMS_SPKG ?? "vendor/erc20Transfers-v0.1.4.spkg";
const OUTPUT_MODULE = process.env.SUBSTREAMS_MODULE ?? "map_transfers";
const API_KEY = process.env.SUBSTREAMS_API_KEY ?? "";

const RESTART_HEAD_OFFSET = -12;
const MAX_BACKOFF_MS = 30_000;
const MAX_EMPTY_ATTEMPTS = 5;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type StreamHandle = { stop: () => void; done: Promise<{ blocksSeen: number }> };
type StreamState = { lastCursor?: string };

async function runStream(
  state: StreamState,
  onBlock: (cursor: string, blockNum: bigint) => Promise<void>,
): Promise<StreamHandle> {
  const pkg = await readPackageFromFile(SPKG);
  const registry = createRegistry(pkg);
  const request = createRequest({
    substreamPackage: pkg,
    outputModule: OUTPUT_MODULE,
    productionMode: true,
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
    console.log(`block ${clock.number} · ${message ? "decoded" : "empty"}`);
    writeChain = writeChain.then(() => onBlock(cursor, clock.number)).catch((e) => console.error("onBlock failed:", e));
  });
  emitter.on("undo", (undo) => {
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
  for (;;) {
    try {
      let blocksSeen = 0;
      const handle = await runStream(state, async (cursor, blockNum) => {
        blocksSeen += 1;
        await saveCursor(cursor, blockNum);
      });
      const result = await handle.done;
      blocksSeen = result.blocksSeen;
      backoffMs = 1000;
      emptyAttempts = blocksSeen > 0 ? 0 : emptyAttempts + 1;
      if (emptyAttempts >= MAX_EMPTY_ATTEMPTS) {
        throw new Error(`${MAX_EMPTY_ATTEMPTS} consecutive attempts with no blocks — giving up`);
      }
      console.log(`stream ended after ${blocksSeen} blocks — retrying in ${backoffMs}ms`);
    } catch (e) {
      emptyAttempts += 1;
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

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  startSubstreams().catch((e) => {
    console.error("substreams manager exited:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
