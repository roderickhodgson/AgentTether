/**
 * Phase 4 settlement engine: the financial lifecycle of stored vouchers.
 *
 * The API (3.3) verifies vouchers and answers 202 WITHOUT settling; this engine
 * settles later from the stored payload — the spike-proven deferred-settle flow
 * (see README "Spike Results" and spikes/deferred-settle.ts, risk #1).
 *
 * Two settlement paths:
 *  - executeSuccessSettlement — the metered usage so far (first match crossed or a
 *    lost trigger recovered by the sweep): settle events_matched × rate (capped at
 *    max_limit), then deliver the event data to the agent's webhook.
 *  - executeTimeoutSettlement — TTL expired: settle the metered usage, or $0 when
 *    nothing matched (no on-chain tx; the authorization simply expires — spike
 *    "zero" mode), then notify the webhook WITHOUT event data unless settle succeeded.
 *
 * Idempotence (README 4.2, three layers):
 *  1. Trigger placement — the engine only ever fires strictly after the atomic
 *     metering commit (see the dataplane's post-commit hook and the sweeps).
 *  2. CAS claim — claimForSettlement() flips MONITORING → SETTLING atomically; a
 *     second concurrent invocation claims 0 rows and no-ops.
 *  3. Permit2 nonce — even if the guard were bypassed, the nonce is consumed
 *     on-chain at settle time; the same voucher physically cannot move funds twice.
 * Crash-window rule: a settle that succeeded on-chain but whose confirmation never
 * reached us leaves the intent SETTLING — the sweep re-drives it, the re-settle is
 * rejected as nonce-consumed, and that rejection is logged CRITICAL for the runbook.
 * We never auto-flip such an intent to SETTLE_FAILED: the money may have moved.
 *
 * Deadline race: the voucher's Permit2 deadline covers ttl + buffer, and the minute
 * sweep settles inside that window — but backend downtime longer than the buffer voids
 * the authorization. A deadline-expired settle rejection marks the intent TIMEOUT
 * (uncollected: agent keeps funds, no data delivers) rather than SETTLE_FAILED.
 *
 * Fail-closed delivery (risk #8): the webhook fires only after the settlement tx
 * receipt confirms on-chain (eth_getTransactionReceipt, no web3 dependency). No
 * confirmed settlement → no data, ever.
 */
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  getIntent,
  getSettlementCandidates,
  claimForSettlement,
  markSettled,
  markSettleFailed,
  markTimeout,
  type PersistedMatchedEvent,
} from "../db.js";
import { facilitator, NETWORK, PAY_TO_ADDRESS } from "./facilitator.js";
import { logger } from "../logger.js";

const RPC_URL = process.env.RPC_URL ?? "https://sepolia.base.org";

// ---- amount math -----------------------------------------------------------

function actualAmountAtomic(eventsMatched: number, ratePerEventAtomic: string, maxLimitAtomic: string): string {
  const metered = BigInt(eventsMatched) * BigInt(ratePerEventAtomic);
  return (metered > BigInt(maxLimitAtomic) ? BigInt(maxLimitAtomic) : metered).toString();
}

// ---- facilitator settle + receipt gate -------------------------------------

type SettleOutcome =
  | { ok: true; txHash: string; amountAtomic: string }
  | { ok: false; reason: string };

async function settleVoucher(payload: PaymentPayload, actualAtomic: string): Promise<SettleOutcome> {
  // Settle-time requirements: the EXACT requirements the voucher was signed against
  // (payload.accepted), with only the amount replaced by the metered actual — this is
  // the pattern the day-1 spike validated, including partial amounts under the ceiling.
  const accepted = payload.accepted as PaymentRequirements;
  if (!accepted) return { ok: false, reason: "stored voucher has no accepted requirements" };
  const settlement = await facilitator.settle(payload, { ...accepted, amount: actualAtomic });
  if (settlement.success && settlement.transaction) {
    return { ok: true, txHash: settlement.transaction, amountAtomic: actualAtomic };
  }
  return { ok: false, reason: settlement.errorReason ?? "settle rejected without a reason" };
}

const UNCERTAIN_REASON = /nonce|already|used|consumed/i;
const DEADLINE_EXPIRED = /deadline/i;

// Receipt gate (fail-closed): poll eth_getTransactionReceipt over plain JSON-RPC until
// the settlement tx exists and succeeded, or give up (leaving the intent SETTLING —
// the sweep re-drives; no webhook fires without a confirmed receipt).
const RECEIPT_TIMEOUT_MS = 60_000;
const RECEIPT_POLL_MS = 3_000;

type RpcResult<T> = { result?: T; error?: { message: string } };

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as RpcResult<T>;
  if (body.error) throw new Error(`${method} failed: ${body.error.message}`);
  return body.result as T;
}

async function receiptConfirmed(txHash: string): Promise<boolean> {
  const deadline = Date.now() + RECEIPT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const receipt = await rpc<{ status: string } | null>("eth_getTransactionReceipt", [txHash]);
      if (receipt) return receipt.status === "0x1";
    } catch (e) {
      logger.warn({ err: e instanceof Error ? e.message : e }, "receipt poll failed — retrying");
    }
    await new Promise((r) => setTimeout(r, RECEIPT_POLL_MS));
  }
  return false;
}

// ---- webhook delivery ------------------------------------------------------

type WebhookNotice = {
  type: "settlement.confirmed" | "intent.timeout";
  intent_id: string;
  agent_wallet: string;
  network: string;
  pay_to: string;
  tx_hash?: string;
  amount_charged_atomic?: string;
  events_matched: number;
  events_truncated: boolean;
  events: Array<{
    chain: string;
    block: number;
    block_timestamp: string;
    tx_hash: string;
    log_index: number;
    from: string;
    to: string;
    amount_atomic: string;
  }>;
};

function eventsForWebhook(stored: unknown, eventsMatched: number): { events: WebhookNotice["events"]; truncated: boolean } {
  const prior = Array.isArray(stored) ? (stored as PersistedMatchedEvent[]) : [];
  return {
    events: prior.map((e) => ({
      chain: e.chain,
      block: e.block,
      block_timestamp: e.blockTimestamp,
      tx_hash: e.txHash,
      log_index: e.logIndex,
      from: e.from,
      to: e.to,
      amount_atomic: e.amount,
    })),
    truncated: eventsMatched > prior.length,
  };
}

async function deliverWebhook(url: string, notice: WebhookNotice): Promise<void> {
  const attempts = 3;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(notice),
        signal: AbortSignal.timeout(10_000),
      });
      logger.info({ intent: notice.intent_id, status: res.status, attempt: i }, "webhook delivered");
      return;
    } catch (e) {
      logger.warn(
        { intent: notice.intent_id, attempt: i, err: e instanceof Error ? e.message : e },
        "webhook delivery failed — retrying",
      );
      if (i < attempts) await new Promise((r) => setTimeout(r, 2_000));
    }
  }
  logger.error({ intent: notice.intent_id, url }, "webhook delivery exhausted retries — settlement stands, agent unreachable");
}

// Shared rejection triage for both settlement paths:
//  - consumed-nonce rejections → leave SETTLING + CRITICAL (money may have moved)
//  - deadline-expired rejections → TIMEOUT, uncollected: the voucher's Permit2 deadline
//    passed before settlement could execute. The minute sweep normally beats the deadline
//    (it settles within the ttl + buffer window); only backend downtime beyond that
//    window voids the authorization. The agent keeps its funds and no data delivers
//    (fail-closed held) — a timeout notice still fires, without event data.
//  - anything else → SETTLE_FAILED (retryable operational failure, e.g. drained balance)
async function handleSettleRejection(
  intentId: string,
  reason: string,
  notice: Pick<WebhookNotice, "agent_wallet" | "events_matched">,
  webhookUrl: string | null,
): Promise<void> {
  if (UNCERTAIN_REASON.test(reason)) {
    if (!uncertainLogged.has(intentId)) {
      uncertainLogged.add(intentId);
      logger.error({ intent: intentId, reason }, "settle rejected with consumed nonce — MANUAL CHECK required (runbook): verify on basescan whether the voucher already settled");
    }
    return;
  }
  if (DEADLINE_EXPIRED.test(reason)) {
    logger.warn({ intent: intentId, reason }, "settle rejected — permit deadline expired, authorization void; marking TIMEOUT (uncollected)");
    await markTimeout(intentId);
    if (!webhookUrl) return;
    await deliverWebhook(webhookUrl, {
      type: "intent.timeout",
      intent_id: intentId,
      agent_wallet: notice.agent_wallet,
      network: NETWORK,
      pay_to: PAY_TO_ADDRESS,
      events_matched: notice.events_matched,
      events_truncated: false,
      events: [],
    });
    return;
  }
  logger.error({ intent: intentId, reason }, "settlement rejected — intent marked SETTLE_FAILED");
  await markSettleFailed(intentId);
}

// ---- the two settlement paths ----------------------------------------------

const uncertainLogged = new Set<string>();

export async function executeSuccessSettlement(intentId: string): Promise<void> {
  const intent = await getIntent(intentId);
  if (!intent || intent.status !== "MONITORING" || !(await claimForSettlement(intent.id))) return;

  const actual = actualAmountAtomic(intent.eventsMatched, intent.ratePerEventAtomic, intent.maxLimitAtomic);
  logger.info({ intent: intentId, amount: actual, eventsMatched: intent.eventsMatched }, "settlement engine: success path");
  if (!intent.paymentPayload) {
    logger.error({ intent: intentId }, "MONITORING intent has no stored voucher — marking SETTLE_FAILED");
    await markSettleFailed(intent.id);
    return;
  }

  const outcome = await settleVoucher(intent.paymentPayload as unknown as PaymentPayload, actual);
  if (!outcome.ok) {
    await handleSettleRejection(intentId, outcome.reason, { agent_wallet: intent.agentWallet, events_matched: intent.eventsMatched }, intent.webhookUrl);
    return;
  }

  if (!(await receiptConfirmed(outcome.txHash))) {
    logger.error({ intent: intentId, tx: outcome.txHash }, "settlement tx unconfirmed in time — leaving SETTLING (fail-closed: no data without a confirmed receipt)");
    return;
  }

  const stored = await markSettled(intent.id, outcome.txHash, outcome.amountAtomic);
  logger.info({ intent: intentId, tx: outcome.txHash, amount: outcome.amountAtomic }, "settled — intent SETTLED, delivering data");
  if (!stored.webhookUrl) return;
  const { events, truncated } = eventsForWebhook(stored.matchedEvents, stored.eventsMatched);
  await deliverWebhook(stored.webhookUrl, {
    type: "settlement.confirmed",
    intent_id: stored.id,
    agent_wallet: stored.agentWallet,
    network: NETWORK,
    pay_to: PAY_TO_ADDRESS,
    tx_hash: outcome.txHash,
    amount_charged_atomic: outcome.amountAtomic,
    events_matched: stored.eventsMatched,
    events_truncated: truncated,
    events,
  });
}

export async function executeTimeoutSettlement(intentId: string): Promise<void> {
  const intent = await getIntent(intentId);
  if (!intent || intent.status !== "MONITORING" || !(await claimForSettlement(intent.id))) return;

  const actual = actualAmountAtomic(intent.eventsMatched, intent.ratePerEventAtomic, intent.maxLimitAtomic);
  logger.info({ intent: intentId, amount: actual, eventsMatched: intent.eventsMatched }, "settlement engine: timeout path");

  // $0 timeout: nothing was metered, so nothing is settled — no on-chain tx, the
  // Permit2 authorization simply expires (spike "zero" mode). Notify without data.
  if (actual === "0") {
    await markTimeout(intent.id);
    logger.info({ intent: intentId }, "timeout with zero metered usage — no settlement tx (authorization expires)");
    if (!intent.webhookUrl) return;
    await deliverWebhook(intent.webhookUrl, {
      type: "intent.timeout",
      intent_id: intent.id,
      agent_wallet: intent.agentWallet,
      network: NETWORK,
      pay_to: PAY_TO_ADDRESS,
      events_matched: 0,
      events_truncated: false,
      events: [],
    });
    return;
  }

  if (!intent.paymentPayload) {
    logger.error({ intent: intentId }, "expired intent has no stored voucher — marking SETTLE_FAILED");
    await markSettleFailed(intent.id);
    return;
  }

  const outcome = await settleVoucher(intent.paymentPayload as unknown as PaymentPayload, actual);
  if (!outcome.ok) {
    await handleSettleRejection(intentId, outcome.reason, { agent_wallet: intent.agentWallet, events_matched: intent.eventsMatched }, intent.webhookUrl);
    return;
  }

  if (!(await receiptConfirmed(outcome.txHash))) {
    logger.error({ intent: intentId, tx: outcome.txHash }, "timeout settlement tx unconfirmed in time — leaving SETTLING (fail-closed)");
    return;
  }

  const stored = await markTimeout(intent.id, outcome.amountAtomic, outcome.txHash);
  logger.info({ intent: intentId, tx: outcome.txHash, amount: outcome.amountAtomic }, "timeout settled metered usage — intent TIMEOUT");
  if (!stored.webhookUrl) return;
  const { events, truncated } = eventsForWebhook(stored.matchedEvents, stored.eventsMatched);
  await deliverWebhook(stored.webhookUrl, {
    type: "intent.timeout",
    intent_id: stored.id,
    agent_wallet: stored.agentWallet,
    network: NETWORK,
    pay_to: PAY_TO_ADDRESS,
    tx_hash: outcome.txHash,
    amount_charged_atomic: outcome.amountAtomic,
    events_matched: stored.eventsMatched,
    events_truncated: truncated,
    events,
  });
}

// ---- sweep: the engine's dispatcher ----------------------------------------

// One pass over every intent owed settlement work (4.3): expired MONITORING goes to the
// timeout path, metered-but-unsettled goes to the success path (lost-trigger recovery),
// stale SETTLING re-drives. CAS claims make double-drive safe, so the sweep can race the
// event-fired trigger without harm.
export async function runSettlementSweep(now = new Date()): Promise<number> {
  const candidates = await getSettlementCandidates(now);
  let acted = 0;
  for (const intent of candidates) {
    const expired = intent.ttlTimestamp < now;
    try {
      if (expired) {
        await executeTimeoutSettlement(intent.id);
      } else if (intent.eventsMatched > 0) {
        await executeSuccessSettlement(intent.id);
      }
      acted += 1;
    } catch (e) {
      logger.error({ intent: intent.id, err: e instanceof Error ? e.message : e }, "sweep settlement attempt failed — will retry next pass");
    }
  }
  if (candidates.length > 0) logger.info({ candidates: candidates.length, acted }, "settlement sweep pass complete");
  return acted;
}
