/**
 * The shareable results page (B.2): every watch gets a URL a human can open —
 * `/w/:intentId` renders the watch, its events, and its settlement; the JSON behind
 * it is `GET /api/v1/intents/:id/report` (CORS-open so a hosted static page can
 * fetch it). The agent's demo output links to this page, so an agent user can show
 * a non-technical person exactly what happened.
 *
 * The report is PRESENTATION-shaped: the DB's bare-hex webhook convention is
 * converted to canonical 0x form here (the report is a new consumer, not the webhook).
 */
import type { Express, Request, Response } from "express";
import { annotateIntent, prisma } from "../db.js";
import { logger } from "../logger.js";
import { NETWORK, USDC_ADDRESS } from "../payments/facilitator.js";
import { readRateLimiter, writeRateLimiter } from "./rateLimit.js";

const DISCLOSURE =
  "The observed data and the payment rail are on different chains by design: events " +
  "are observed on Ethereum mainnet; x402 settlement executes on Base Sepolia " +
  "(or Hedera testnet).";

type PersistedEvent = {
  chain: string;
  block: number;
  blockTimestamp: string;
  txHash: string;
  logIndex: number;
  from: string;
  to: string;
  amount: string;
};

const hex0x = (h: string) => (h.startsWith("0x") ? h.toLowerCase() : `0x${h.toLowerCase()}`);
const KNOWN_ASSETS = new Set([
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // mainnet USDC
  "0x036cbd53842c5426634e7929541ec2318f3dcf7e", // Base Sepolia USDC
]);

function assetName(contract: string): string {
  const bare = contract.toLowerCase();
  return KNOWN_ASSETS.has(bare) || KNOWN_ASSETS.has(`0x${bare}`) ? "USDC" : contract;
}

export type IntentReport = {
  intent: {
    id: string;
    status: string;
    asset: string | null;
    target_contract: string | null;
    watch_wallet: string | null;
    direction: string | null;
    min_amount_atomic: string;
    created_at: string;
    expires_at: string;
    budget_blocks: number;
    per_block_rate_atomic: string;
    max_limit_atomic: string;
  };
  lifecycle: Array<{ step: string; at: string; detail?: Record<string, unknown> }>;
  matched: {
    count: number;
    stored: number;
    truncated: boolean;
    events: Array<{
      block: number;
      block_timestamp: string;
      tx_hash: string;
      from: string;
      to: string;
      amount_atomic: string;
    }>;
  };
  settlement: {
    tx_hash: string | null;
    amount_charged_atomic: string | null;
    explorer_url: string | null;
    note: string;
  };
  disclosure: string;
};

export function buildReport(intent: {
  id: string;
  status: string;
  targetContract: string | null;
  watchWallet?: string | null;
  direction?: string | null;
  eventCondition: unknown;
  createdAt: Date;
  ttlTimestamp: Date;
  budgetBlocks: number;
  perBlockRateAtomic: string;
  maxLimitAtomic: string;
  eventsMatched: number;
  matchedEvents: unknown;
  lifecycle?: unknown;
  settlementTxHash: string | null;
  settledAmountAtomic: string | null;
}): IntentReport {
  const stored = (Array.isArray(intent.matchedEvents) ? intent.matchedEvents : []) as PersistedEvent[];
  const events = stored.map((e) => ({
    block: Number(e.block),
    block_timestamp: e.blockTimestamp,
    tx_hash: hex0x(e.txHash),
    from: hex0x(e.from),
    to: hex0x(e.to),
    amount_atomic: String(e.amount),
  }));
  const minAmount =
    (intent.eventCondition as { minAmount?: string } | null)?.minAmount ?? "0";

  const settled = intent.settlementTxHash != null;
  const settlement = {
    tx_hash: intent.settlementTxHash ? hex0x(intent.settlementTxHash) : null,
    amount_charged_atomic: intent.settledAmountAtomic,
    explorer_url: intent.settlementTxHash
      ? `https://sepolia.basescan.org/tx/${hex0x(intent.settlementTxHash)}`
      : null,
    note: settled
      ? "Settled on-chain after the settlement receipt confirmed (fail-closed delivery)."
      : intent.status === "TIMEOUT"
        ? "The window expired with no blocks processed — nothing was charged (the watch never opened)."
        : intent.status === "EXPIRED"
          ? "The offer expired unpaid — nothing was charged."
          : "No on-chain settlement yet.",
  };

  return {
    intent: {
      id: intent.id,
      status: intent.status,
      asset: intent.targetContract ? assetName(intent.targetContract) : null,
      target_contract: intent.targetContract ? hex0x(intent.targetContract) : null,
      watch_wallet: intent.watchWallet ? hex0x(intent.watchWallet) : null,
      direction: intent.direction ?? null,
      min_amount_atomic: minAmount,
      created_at: intent.createdAt.toISOString(),
      expires_at: intent.ttlTimestamp.toISOString(),
      budget_blocks: intent.budgetBlocks,
      per_block_rate_atomic: intent.perBlockRateAtomic,
      max_limit_atomic: intent.maxLimitAtomic,
    },
    lifecycle: (Array.isArray(intent.lifecycle) ? intent.lifecycle : []) as IntentReport["lifecycle"],
    matched: {
      count: intent.eventsMatched,
      stored: events.length,
      truncated: intent.eventsMatched > events.length,
      events,
    },
    settlement,
    disclosure: DISCLOSURE,
  };
}

// The SITE base for report links handed to agents (202 bodies, webhook notices, the
// recent list). PUBLIC_SITE_URL is the hosted tier (Netlify / an https domain) — the
// default documents the local dev site (`netlify dev` on :8888). The backend serves
// NO HTML: it is API-only; the pages live on the web tier.
export function publicBaseUrl(): string {
  return (process.env.PUBLIC_SITE_URL ?? "http://localhost:8888").replace(/\/$/, "");
}

export function reportUrlFor(id: string, _base?: string): string {
  return `${publicBaseUrl()}/w/${id}`;
}

// Public, wallet-free summary rows for the home page's "recent requests" list.
// RECENT_INTENTS_LIMIT is the default count (.env), the query param caps at 20.
function recentLimit(queryLimit: string | undefined): number {
  const configured = Number(process.env.RECENT_INTENTS_LIMIT ?? 5);
  const requested = Number(queryLimit ?? configured);
  return Math.min(20, Math.max(1, Number.isFinite(requested) ? Math.floor(requested) : configured));
}

export function mountReport(app: Express): void {
  app.get("/api/v1/intents/recent", readRateLimiter, async (req: Request, res: Response) => {
    res.set("Access-Control-Allow-Origin", "*");
    const rows = await prisma.intent.findMany({
      orderBy: { createdAt: "desc" },
      take: recentLimit(req.query.limit as string | undefined),
      select: {
        id: true,
        status: true,
        targetContract: true,
        watchWallet: true,
        direction: true,
        eventCondition: true,
        createdAt: true,
        ttlTimestamp: true,
        settlementTxHash: true,
        settledAmountAtomic: true,
        eventsMatched: true,
      },
    });
    res.json({
      requests: rows.map((r) => ({
        id: r.id,
        status: r.status,
        asset: r.targetContract ? assetName(r.targetContract) : null,
        watch_wallet: r.watchWallet ? hex0x(r.watchWallet) : null,
        direction: r.direction ?? null,
        min_amount_atomic: (r.eventCondition as { minAmount?: string } | null)?.minAmount ?? "0",
        created_at: r.createdAt.toISOString(),
        events_matched: r.eventsMatched,
        settled: r.settlementTxHash != null,
        report_url: reportUrlFor(r.id),
      })),
    });
  });

  // Optional agent annotations (the flow-chart's LLM rows): unauthenticated, append-only,
  // length-capped; stored with an `agent:` prefix so they can't spoof backend steps.
  app.post("/api/v1/intents/:id/annotate", writeRateLimiter, async (req: Request, res: Response) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Headers", "content-type");
    const id = String(req.params.id);
    const body = (req.body ?? {}) as { step?: unknown; detail?: unknown };
    const step = typeof body.step === "string" ? body.step.trim() : "";
    if (!step) {
      res.status(400).json({ error: "step (string) is required" });
      return;
    }
    if (body.detail !== undefined && (typeof body.detail !== "object" || body.detail === null)) {
      res.status(400).json({ error: "detail must be an object" });
      return;
    }
    const detail = JSON.parse(JSON.stringify(body.detail ?? {})) as Record<string, unknown>;
    const ok = await annotateIntent(id, step.slice(0, 200), detail);
    res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: "unknown intent" });
  });

  app.get("/api/v1/intents/:id/report", readRateLimiter, async (req: Request, res: Response) => {
    res.set("Access-Control-Allow-Origin", "*"); // hosted static pages fetch this
    try {
      const id = String(req.params.id); // express 5 types params as string | string[]
      const intent = await prisma.intent.findUnique({ where: { id } });
      if (!intent) {
        res.status(404).json({ error: "unknown intent" });
        return;
      }
      res.json(buildReport(intent));
    } catch (e) {
      logger.error({ err: e instanceof Error ? e.message : e }, "report endpoint failed");
      res.status(500).json({ error: "report failed" });
    }
  });

  // CORS preflight — required for the HOSTED pages (https Netlify site → https API):
  // without a 204 OPTIONS response the browser blocks the POST annotate call entirely.
  app.options("/api/v1/intents/:id/annotate", (_req: Request, res: Response) => {
    res.set({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "content-type",
    });
    res.sendStatus(204);
  });

  logger.info("public API mounted: report JSON · recent · annotate (HTML lives on the web tier)");
}
