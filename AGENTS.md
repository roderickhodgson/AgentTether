# AGENTS.md

Guidance for AI coding agents (and humans) working on this repo. The README is the plan of record — read it first; this file covers standing rules and facts that are easy to get wrong.

## Git workflow (hard rules)

- **Never `git push`.** The owner performs all pushes personally.
- Commit style: lowercase imperative one-liners, descriptive (match `git log`).
- Commit incrementally as work progresses — verify each step (typecheck and/or a live run) before committing it.
- **Never commit secrets.** `.env` is gitignored (DATABASE_URL, API keys, private keys live there). Never stage it.
- Public wallet addresses also stay out of code and history — read them from env (`AGENT_WALLET`); history was scrubbed once already with `git filter-repo`, keep it that way.

## Project setup

- Node **ESM** (`"type": "module"`). Run TS via `tsx`; local imports need `.js` extensions. `@substreams/*` packages are ESM-only.
- Run `npm run typecheck` (`tsc --noEmit`) before every commit.
- **Pinned dependencies — do not bump casually:**
  - `@x402/*` at 2.25.0 (the versions the day-1 spike validated against the hosted facilitator)
  - `prisma` / `@prisma/client` at 6.x (v7's config model — URLs out of schema, driver adapters — was deliberately avoided; revisit only with cause)

## Handy scripts

| Script | What it does |
|---|---|
| `npm run smoke` | DB CRUD lifecycle test against Neon (writes + deletes a row — don't run concurrently with a live demo) |
| `npm run fixture` | Seeds a fresh `MONITORING` intent on mainnet USDC (simulates a paid intent; one new intent per run) |
| `npm run stream` | Runs the data-plane stream standalone (reconnect loop, cursor resume, metering) |
| `npm run reset` | Demo reset: deletes all intents + the cursor (confirm prompt, `-- --force` to skip) so the next stream starts fresh from head |
| `npm run wallet-check` | Read-only report: ETH/USDC balances + Permit2 allowance for `AGENT_WALLET` and `PAY_TO_ADDRESS` (plain JSON-RPC, no tx, no web3 dep) |
| `npm test` | Fast vitest suite: pure units + mocked HTTP/orchestration — no DB, no chain, no money (matcher window semantics, engine triage, router branch table) |
| `npm run test:integration` | DB-backed tests against the Neon **branch** (`TEST_DATABASE_URL` in `.env`) — isolated copy, safe to run during a live demo |
| `npm run verify:live` | Pre-demo live verification: stream-client e2e + settlement e2e (needs `npm start` running; moves testnet USDC) |
| `npm run dev` / `start` | Express backend (`/healthz`) |

## Architecture facts (rediscovering these is expensive)

- **Payment plane is Base Sepolia only.** The hosted default facilitator advertises `upto`/`exact` solely for `eip155:84532` — Ethereum Sepolia and other L2s are not supported. The constraint is the settlement service's. The data plane is chain-agnostic by design.
- **Data-plane spkg:** `vendor/erc20Transfers-v0.1.4.spkg` (Pinax, sha256-pinned, module `map_transfers`, output `erc20.types.v1.TransferEvents`). `streamingfast/substreams-eth-token-transfers` is **disqualified** — its output proto has no contract address, so `target_contract` filtering is impossible.
- **Head-streaming is the default, not `finalBlocksOnly`** — finality-only delivery delays first block by up to ~13 min on Ethereum. Undo handling = revert persisted cursor to the undo's `lastValidCursor` (counter rollback deliberately skipped). `SUBSTREAMS_FINAL_BLOCKS_ONLY=true` opts into finality mode.
- **Billing unit = processed block** (block-number arithmetic: `cursor.blockNum − startBlockNum + 1`, capped by `budgetBlocks` — no per-block counters). `eventsMatched` is delivery content + the first-match trigger, not billing. The block-budget guard stops matching (and catch-up work) at the paid boundary; the TTL is the time backstop. Downtime catch-up replays only in-window blocks, and `startBlockNum` is set at the first in-window block — pre-creation replay is never billed.
- **Delivery is fail-closed:** webhook data fires only after a confirmed settlement receipt (risk #8 invariant — never reorder deliver-before-settle).
- **x402 flow split:** the `/stream` route must bypass `paymentMiddleware` auto-settlement (manual facilitator `/verify`, deferred `/settle`); `/oneshot` uses the standard middleware (flat fee auto-settled after the handler responds). Deferred partial settlement of a stored voucher was spike-proven — see README "Spike Results".
- **Oneshot capture invariant:** `ProcessedTransfer` rows are written in the SAME per-block transaction as metering + the cursor — the cursor never advances past uncaptured blocks. Capture rows carry the canonical `0x`-prefixed web3 form; the matched-events webhook payload keeps the bare-hex convention (do not "fix" either to match the other). Two prunes: retention (`ONESHOT_RETENTION_HOURS`) + post-undo pruning above the reverted cursor.
- **Oneshot rails:** one `PaymentOption` per network in `accepts` + one `HTTPFacilitatorClient` per rail = the dual-rail routing. The hedera option only advertises together with its scheme server registration (`@x402/hedera`) — never advertise an option the middleware can't verify.
- **Facilitators:** default `https://x402.org/facilitator` (EVM + Hedera fallback); Blocky402 `https://api.testnet.blocky402.com` for Hedera (bounty-mandated routing). Discover `facilitatorAddress`/`feePayer` from `GET /supported` at startup — never hardcode.
- **Facilitator verifies can also bounce transiently** (observed on the oneshot: a paid request silently answered `402 {}` with no server-side log — passed on retry). Same flakiness family as the settle bounces below; clients should retry a 402-once-paid once before treating it as structural.
- The substreams CLI's `--endpoint` flag needs an explicit `:443` port suffix; the JS SDK does not.
- Block timestamps come from the stream's `Clock`, not the transfer events.
- **Pricing is per-block and server-owned:** the ceiling is quoted as `⌈ttl ÷ blockTime⌉ × PER_BLOCK_RATE_ATOMIC` (default 100; `BLOCK_TIME_S` per-chain, default 12s mainnet); clients sending `rate_per_event_atomic` or `max_limit_atomic` get a 400. The window ends at whichever runs out first — block budget or TTL — and settlement is exactly the blocks processed. Block counts are block-number arithmetic (`cursor.blockNum − startBlockNum + 1`), not counters; `startBlockNum` is lazily set at the first in-window block (never during pre-creation catch-up replay).
- **Permit2 vouchers are single-use by design** (the nonce is consumed on settle) — one voucher, one settle. Multi-settle metering would require pre-signed voucher chains; the product deliberately doesn't need it (single-callback intents + client re-issue covers the use case).
- **Single-writer rule (ops):** exactly one backend instance may stream against the DB — two instances double-*meter* (the Permit2 nonce still prevents double-*charge*).
- **Permit2 allowance erodes:** the allowance-mode approval *decrements per settlement* — not "approve max once, forever". The client's per-run pre-check (`allowance ≥ ceiling`) re-bootstraps automatically.
- **Facilitator settles can bounce transiently** (observed: stale wallet nonce / queue congestion on the hosted facilitator → `invalid_exact_evm_transaction_failed`). The engine's triage leaves such intents `SETTLING` and retries within the voucher's deadline window (ttl + 120s); only structural rejections go terminal.

## Docs-as-plan

- `README.md` holds the implementation checklist and ordered risk register — keep both updated as work completes. Facts already verified live are documented there (with links/evidence); don't restate or contradict them.
- `.opencode/skills/` contains `substreams-*` reference skills — load them for Substreams-related work.
