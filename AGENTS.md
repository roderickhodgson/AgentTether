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
| `npm run dev` / `start` | Express backend (`/healthz`) |

## Architecture facts (rediscovering these is expensive)

- **Payment plane is Base Sepolia only.** The hosted default facilitator advertises `upto`/`exact` solely for `eip155:84532` — Ethereum Sepolia and other L2s are not supported. The constraint is the settlement service's. The data plane is chain-agnostic by design.
- **Data-plane spkg:** `vendor/erc20Transfers-v0.1.4.spkg` (Pinax, sha256-pinned, module `map_transfers`, output `erc20.types.v1.TransferEvents`). `streamingfast/substreams-eth-token-transfers` is **disqualified** — its output proto has no contract address, so `target_contract` filtering is impossible.
- **Head-streaming is the default, not `finalBlocksOnly`** — finality-only delivery delays first block by up to ~13 min on Ethereum. Undo handling = revert persisted cursor to the undo's `lastValidCursor` (counter rollback deliberately skipped). `SUBSTREAMS_FINAL_BLOCKS_ONLY=true` opts into finality mode.
- **Metering unit = matching event** (not block). TTL is enforced by a block-timestamp guard in the matcher; increments are batched per block. Downtime catch-up replays all blocks since the cursor and meters only in-TTL events.
- **Delivery is fail-closed:** webhook data fires only after a confirmed settlement receipt (risk #8 invariant — never reorder deliver-before-settle).
- **x402 flow split:** the `/stream` route must bypass `paymentMiddleware` auto-settlement (manual facilitator `/verify`, deferred `/settle`); `/oneshot` may use it. Deferred partial settlement of a stored voucher was spike-proven — see README "Spike Results".
- **Facilitators:** default `https://x402.org/facilitator` (EVM + Hedera fallback); Blocky402 `https://api.testnet.blocky402.com` for Hedera (bounty-mandated routing). Discover `facilitatorAddress`/`feePayer` from `GET /supported` at startup — never hardcode.
- The substreams CLI's `--endpoint` flag needs an explicit `:443` port suffix; the JS SDK does not.
- Block timestamps come from the stream's `Clock`, not the transfer events.

## Docs-as-plan

- `README.md` holds the implementation checklist and ordered risk register — keep both updated as work completes. Facts already verified live are documented there (with links/evidence); don't restate or contradict them.
- `.opencode/skills/` contains `substreams-*` reference skills — load them for Substreams-related work.
