# AgentTether API — the client contract for agents

Everything a third-party agent needs to buy and use a paid blockchain watch. The API
is agent-agnostic: no accounts, no sessions, no SDK required — plain HTTP plus one
x402 payment step. Our own LangGraph agent (agent/) is just one client of this
contract; yours can be anything that can sign a Permit2 voucher.

Base URL: the public API (e.g. `https://api.agenttether.cc`). The home page carries
the live base; hosted pages take a per-URL `?api=` override.

Data-plane scope: watches observe **ERC-20 `Transfer` events only** — asset-based
and/or wallet-based. The observed chain (data plane) is independent of the payment
chain (settlement); a disclosure of that split is part of every result you receive.

## 1. Buy a watch — `POST /api/v1/intents/stream`

**Phase 1 — get the quote (no payment header).** POST the watch description:

```json
{
  "query_intent": "watch mainnet USDC for large transfers",
  "target_contract": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  "watch_wallet": "0x…",            // optional; either selector or both
  "direction": "incoming",           // optional, only with watch_wallet
  "event_condition": { "minAmount": "1000000" },  // optional; atomic units; {} = any
  "ttl_seconds": 60,                 // required, 60..86400
  "webhook_url": "https://your-host/hook"          // optional; must be https
}
```

Validation is strict: at least one selector (`target_contract` and/or
`watch_wallet`), `direction` ∈ `incoming|outgoing|any`, atomic-unit strings, webhook
https (loopback http allowed for local dev). Errors are 400 with a `problems` array.
**Pricing is server-owned — never send `rate_per_event_atomic` or
`max_limit_atomic`; you get a 400.**

The response is **402** with the payment requirements, both as a JSON body and
base64url-encoded in the `PAYMENT-REQUIRED` header (x402 v2):

```json
{
  "x402Version": 2,
  "resource": { "url": "…/api/v1/intents/stream?intent=<id>", "description": "…", "mimeType": "application/json" },
  "accepts": [{
    "scheme": "upto", "network": "eip155:84532",
    "asset": "<USDC on the settlement chain>", "payTo": "<our receiver>",
    "amount": "<ceiling atomic>",   // your worst case: budgetBlocks × perBlockRate
    "maxTimeoutSeconds": 180,       // ttl + 120s — the Permit2 deadline hint
    "extra": { "perBlockRateAtomic": "100", "budgetBlocks": 5, "blockTimeSeconds": 12, "facilitatorAddress": "…" }
  }]
}
```

Sign one Permit2 `permit` (EIP-3005-style, as x402 expects) for **exactly the quoted
ceiling** to `payTo`, with a deadline ≥ `ttl + 120s` — the voucher must outlive the
whole watch. `upto` semantics: you can never be charged more than `amount`; actual
settlement is the blocks processed, pro-rata.

**Phase 2 — pay (the voucher).** Re-POST the same body with
`PAYMENT-SIGNATURE: <base64url x402 PaymentPayload>`. On success: **202**

```json
{ "job_id": "…", "status": "MONITORING", "agent_wallet": "0x…",
  "events_matched": 0, "ttl_timestamp": "…", "report_url": "https://…/report?i=<job_id>" }
```

Keep `job_id` and `report_url`. Idempotency: replaying the same voucher (same Permit2
nonce) for the same intent returns the same 202; a nonce bound to another intent is a
409. Vouchers are **single-use** — to keep listening past the window, buy another one
(the re-issue loop; see §4).

## 2. Receive the results — the webhook

Delivery is **fail-closed**: the webhook fires only after the settlement receipt is
confirmed on-chain. POSTed to your `webhook_url`, `content-type: application/json`,
3 attempts (10s timeout, 2s backoff), expects a 200. Shape:

```json
{
  "type": "settlement.confirmed",  // or "intent.timeout" (window expired)
  "intent_id": "…", "agent_wallet": "0x…", "network": "…", "pay_to": "0x…",
  "tx_hash": "0x…",                 // settlement tx (absent when nothing was billed)
  "amount_charged_atomic": "…",     // absent when nothing was billed
  "events_matched": 2, "events_truncated": false,
  "events": [{ "chain": "ethereum-mainnet", "block": 0, "block_timestamp": "…",
               "tx_hash": "0x…", "log_index": 0, "from": "0x…", "to": "0x…", "amount_atomic": "…" }],
  "report_url": "https://…/report?i=<intent_id>"
}
```

A timeout with no `tx_hash` and no amount means the window ended with zero processed
blocks — nothing was charged. If your webhook is unreachable after the retries,
settlement still stands and the report URL remains the way to see the outcome.

## 3. Tell your story — lifecycle annotations (optional)

The public flow-chart (`report_url`) shows the backend lifecycle automatically
(requested → paid → window opened → settled/expired → delivered). Your agent can add
its own rows — narration, decisions, what it did next — so a human can follow the
whole story:

```json
POST /api/v1/intents/<job_id>/annotate
{ "step": "decide", "detail": { "outcome": "reissue", "reason": "objective wants a longer watch" } }
```

- `step` — required string, ≤200 chars; stored as `agent: <step>` (first 40 chars)
  with a **server** timestamp, so it can never impersonate backend steps.
- `detail` — optional JSON object (arbitrary keys), rendered as key/values.
- Responses: 200 `{ok:true}` · 400 (missing/invalid step) · 404 (unknown intent).
- Unauthenticated, CORS `*`, rate-limited together with the write endpoints
  (default 30/min per IP → 429 `{error}` with `RateLimit-*` headers).

Our agent annotates `plan`, `observe`, `decide`, `decision` — use whatever names tell
your story best.

## 4. Keep listening — the re-issue loop

One voucher settles exactly once (the Permit2 nonce is consumed on settle). To watch
longer than one window, the agent re-runs §1 with the same watch parameters and a
fresh voucher, and keeps the same webhook receiver. The flow-chart then shows each
window as its own intent — that's the `decide → reissue` pattern visible on the
public reports.

## 5. Read-only endpoints

- `GET /api/v1/intents/:id/report` — the full JSON behind the flow-chart: watch
  parameters, lifecycle (backend steps + your `agent:` rows), matched events
  (first 50 stored, counter keeps counting), settlement (tx + amount + explorer link).
- `GET /api/v1/intents/recent?limit=N` — recent watches (default `RECENT_INTENTS_LIMIT`,
  capped at 20). Public by design; UUIDs are unguessable.

## Cross-chain disclosure (reproduce it in your narration)

Observation happens on a high-velocity chain (Ethereum mainnet); x402 settlement
executes on a testnet (Base Sepolia, or Hedera testnet via the Blocky402 rail). The
observed data and the payment rail are on different chains by design.
