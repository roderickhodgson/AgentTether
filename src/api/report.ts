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
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../db.js";
import { logger } from "../logger.js";
import { NETWORK, USDC_ADDRESS } from "../payments/facilitator.js";

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
    asset: string;
    target_contract: string;
    min_amount_atomic: string;
    created_at: string;
    expires_at: string;
    budget_blocks: number;
    per_block_rate_atomic: string;
    max_limit_atomic: string;
  };
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
  targetContract: string;
  eventCondition: unknown;
  createdAt: Date;
  ttlTimestamp: Date;
  budgetBlocks: number;
  perBlockRateAtomic: string;
  maxLimitAtomic: string;
  eventsMatched: number;
  matchedEvents: unknown;
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
  const zeroBlocks = !settled && intent.status === "TIMEOUT";
  const settlement = {
    tx_hash: intent.settlementTxHash ? hex0x(intent.settlementTxHash) : null,
    amount_charged_atomic: intent.settledAmountAtomic,
    explorer_url: intent.settlementTxHash
      ? `https://sepolia.basescan.org/tx/${hex0x(intent.settlementTxHash)}`
      : null,
    note: settled
      ? "Settled on-chain after the settlement receipt confirmed (fail-closed delivery)."
      : zeroBlocks
        ? "The window expired with no blocks processed — nothing was charged (the watch never opened)."
        : "No on-chain settlement yet.",
  };

  return {
    intent: {
      id: intent.id,
      status: intent.status,
      asset: assetName(intent.targetContract),
      target_contract: hex0x(intent.targetContract),
      min_amount_atomic: minAmount,
      created_at: intent.createdAt.toISOString(),
      expires_at: intent.ttlTimestamp.toISOString(),
      budget_blocks: intent.budgetBlocks,
      per_block_rate_atomic: intent.perBlockRateAtomic,
      max_limit_atomic: intent.maxLimitAtomic,
    },
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

export function mountReport(app: Express): void {
  app.get("/api/v1/intents/:id/report", async (req: Request, res: Response) => {
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

  app.get("/w/:id", async (req: Request, res: Response) => {
    const page = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../web/report.html");
    res.sendFile(page, (err) => {
      if (err) res.status(500).send("report page missing (web/report.html)");
    });
  });
}
