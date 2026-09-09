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
| `npm run verify:live` | Pre-demo live verification: stream-client e2e + settlement e2e + oneshot e2e (both rails) (needs `npm start` running; moves testnet USDC + HBAR; gated on a stream-liveness check — a stale cursor fails fast instead of letting every watch expire unbilled) |
| `npm run dev` / `start` | Express backend (`/healthz`) |

## Architecture facts (rediscovering these is expensive)

- **Payment plane is Base Sepolia only.** The hosted default facilitator advertises `upto`/`exact` solely for `eip155:84532` — Ethereum Sepolia and other L2s are not supported. The constraint is the settlement service's. The data plane is chain-agnostic by design.
- **Data-plane spkg:** `vendor/erc20Transfers-v0.1.4.spkg` (Pinax, sha256-pinned, module `map_transfers`, output `erc20.types.v1.TransferEvents`). `streamingfast/substreams-eth-token-transfers` is **disqualified** — its output proto has no contract address, so `target_contract` filtering is impossible.
- **Head-streaming is the default, not `finalBlocksOnly`** — finality-only delivery delays first block by up to ~13 min on Ethereum. Undo handling = revert persisted cursor to the undo's `lastValidCursor` (counter rollback deliberately skipped). `SUBSTREAMS_FINAL_BLOCKS_ONLY=true` opts into finality mode.
- **Billing unit = processed block** (block-number arithmetic: `cursor.blockNum − startBlockNum + 1`, capped by `budgetBlocks` — no per-block counters). `eventsMatched` is delivery content + the first-match trigger, not billing. The block-budget guard stops matching (and catch-up work) at the paid boundary; the TTL is the time backstop. Downtime catch-up replays only in-window blocks, and `startBlockNum` is set at the first in-window block — pre-creation replay is never billed.
- **Intents select by asset and/or wallet** (`watch_wallet` + optional `direction` `incoming|outgoing|any`, default `any`; `target_contract` optional when a wallet is watched). Router requires ≥1 selector and 400s otherwise; `matchesIntent` fails closed on the same rule. `minAmount` is optional everywhere — absent/blank means any transfer of the watched subject. **Live beat (Sep 9):** scripted agent watching a mainnet exchange hot-wallet for incoming any-token transfers → 92 events in the first processed block, settled 100 atomic = exactly 1 block, full graph loop PASS. The first attempt against a *different* (genuinely quiet) hot wallet matched nothing across 20 blocks — cross-check reality with `eth_getLogs` before suspecting the matcher: publicnode requires an `address` filter in getLogs (its -32701 error is easy to swallow and misread as "no events"); `eth.drpc.org` serves topic-only queries.
- **Delivery is fail-closed:** webhook data fires only after a confirmed settlement receipt (risk #8 invariant — never reorder deliver-before-settle).
- **x402 flow split:** the `/stream` route must bypass `paymentMiddleware` auto-settlement (manual facilitator `/verify`, deferred `/settle`); `/oneshot` uses the standard middleware (flat fee auto-settled after the handler responds). Deferred partial settlement of a stored voucher was spike-proven — see README "Spike Results".
- **Oneshot capture invariant:** `ProcessedTransfer` rows are written in the SAME per-block transaction as metering + the cursor — the cursor never advances past uncaptured blocks. Capture rows carry the canonical `0x`-prefixed web3 form; the matched-events webhook payload keeps the bare-hex convention (do not "fix" either to match the other). Two prunes: retention (`ONESHOT_RETENTION_HOURS`) + post-undo pruning above the reverted cursor.
- **Oneshot rails:** one `PaymentOption` per network in `accepts` + one `HTTPFacilitatorClient` per rail = the dual-rail routing. **Array order IS the routing** — Blocky402 first makes it the hedera primary; it doesn't advertise `eip155:84532`, so Base falls through to the default. Both rails are live (Base USDC 500 atomic; Hedera 0.001 ℏ via Blocky402, settle tx from fee payer `0.0.7162784`).
- **Hedera specifics:** `HEDERA_PAY_TO` takes `0x…` (resolved to `0.0.x` via the testnet mirror at mount; rail unadvertised while the account doesn't exist) or `0.0.x`. A payer account created by an incoming HBAR transfer is *hollow* (`key: null`) until its ECDSA key signs once — `spikes/hedera-activate.ts` (1 tinybar) fixes it; Blocky402's verify fetches the on-chain key and fails closed on null. The x402 client's spend controls reject HBAR (`0.0.0`) as a non-default asset — demo client uses `x402Client.fromConfig({ schemes: [], spendControls: false })`. Never advertise an option the middleware can't verify.
- **Facilitators:** default `https://x402.org/facilitator` (EVM + Hedera fallback); Blocky402 `https://api.testnet.blocky402.com` for Hedera (bounty-mandated routing). Discover `facilitatorAddress`/`feePayer` from `GET /supported` at startup — never hardcode.
- **Facilitator verifies can also bounce transiently** (observed on the oneshot: a paid request silently answered `402 {}` with no server-side log — passed on retry). Same flakiness family as the settle bounces below; clients should retry a 402-once-paid once before treating it as structural.
- **Python agent (Phase 5) lives in `agent/`** (venv, `pip install -r requirements.txt && pip install -e .`, `pytest -q`). The Python x402 SDK is pinned at **2.22.0** (latest PyPI; behind the Node 2.25.0 pins — the skew is spike-gated, see README 5.2). Webhook notice types on the wire: `settlement.confirmed` (delivery after settle) and `intent.timeout` (expiry). A ≥1000-USDC floor on mainnet USDC **fires in the first in-window block** — not an idle beat; use a 1B-USDC floor for the timeout beat. The LangGraph agent pauses via `interrupt()` at `wait_for_webhook` and resumes from the Flask receiver thread via `Command(resume=notice)`; the LLM layer is `AGENT_LLM=opencode` (default `scripted`) talking to `opencode serve` (`OPENCODE_SERVER_URL`) — no extra API key; the LLM never touches keys. `AGENT_WALLET` pins are validated against `EVM_PRIVATE_KEY` at load. `scripts/demo_agent.py --watch-json '<json>'` overrides the plan default (e.g. `{"watch_wallet": "0x…", "direction": "incoming"}`) — the scripted LLM picks up the override from the plan prompt's defaults block; the plan/negotiate/narration nodes speak wallet watching natively.
- The substreams CLI's `--endpoint` flag needs an explicit `:443` port suffix; the JS SDK does not.
- Block timestamps come from the stream's `Clock`, not the transfer events.
- **Pricing is per-block and server-owned:** the ceiling is quoted as `⌈ttl ÷ blockTime⌉ × PER_BLOCK_RATE_ATOMIC` (default 100; `BLOCK_TIME_S` per-chain, default 12s mainnet); clients sending `rate_per_event_atomic` or `max_limit_atomic` get a 400. The window ends at whichever runs out first — block budget or TTL — and settlement is exactly the blocks processed. Block counts are block-number arithmetic (`cursor.blockNum − startBlockNum + 1`), not counters; `startBlockNum` is lazily set at the first in-window block (never during pre-creation catch-up replay).
- **Permit2 vouchers are single-use by design** (the nonce is consumed on settle) — one voucher, one settle. Multi-settle metering would require pre-signed voucher chains; the product deliberately doesn't need it (single-callback intents + client re-issue covers the use case).
- **Single-writer rule — enforced in code:** `src/lease.ts` claims a heartbeat lease (`process_lease`, 30s TTL, holder `hostname:pid:started-at`) before the stream starts; a second instance **hard-exits(1)** and its supervisor retries until the dead holder's lease goes stale (graceful shutdown releases instantly — SIGTERM/SIGINT handlers stop stream → release → disconnect). Daemon configs for launchd + systemd live in `deploy/` (see `deploy/README.md`; `deploy/start.sh` resolves the nvm node path — update it on node upgrades). Sweeps are CAS-safe and oneshot reads are read-only, so an API-only process against the same DB is harmless.
- **Permit2 allowance erodes:** the allowance-mode approval *decrements per settlement* — not "approve max once, forever". The client's per-run pre-check (`allowance ≥ ceiling`) re-bootstraps automatically.
- **Facilitator settles can bounce transiently** (observed: stale wallet nonce / queue congestion on the hosted facilitator → `invalid_exact_evm_transaction_failed`). The engine's triage leaves such intents `SETTLING` and retries within the voucher's deadline window (ttl + 120s); only structural rejections go terminal.

## Docs-as-plan

- `README.md` holds the implementation checklist and ordered risk register — keep both updated as work completes. Facts already verified live are documented there (with links/evidence); don't restate or contradict them.
- `.opencode/skills/` contains `substreams-*` reference skills — load them for Substreams-related work.
