# AgentTether agent (Phase 5)

The AI agent half of AgentTether: a Python client that negotiates x402 payments,
provisions paid blockchain watches, and — in the LangGraph build — pauses patiently
for webhook delivery instead of polling. See the repo-root `README.md` (Phase 5) for
the design notes; this file is the runbook.

## Setup

```bash
cd agent
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/pip install -e .
.venv/bin/pytest -q          # offline unit tests
```

Configuration comes from the repo-root `.env` (shared with the backend): at minimum
`EVM_PRIVATE_KEY` (the agent payer). Optional pins: `AGENT_WALLET` (must match the
key — validated at load), `SERVER_URL`, `RPC_URL`, `AGENT_WEBHOOK_PORT`,
`AGENT_LLM` (`opencode` | `scripted`), `OPENCODE_SERVER_URL`.

## State

- `state.json` (gitignored) — allowance fast-path cache. Advisory only: the on-chain
  pre-check runs on every flow (the Permit2 allowance *decrements* per settlement).

## The LangGraph agent

```bash
.venv/bin/python scripts/demo_agent.py              # agentic demo (re-issue loop on)
.venv/bin/python scripts/demo_agent.py --reissues 0 # single watch
AGENT_LLM=scripted .venv/bin/python scripts/demo_agent.py   # deterministic (no LLM)
```

Flow: `plan` (LLM picks watch params) → `negotiate` (x402 402→Permit2 voucher→202,
deterministic) → **`wait_for_webhook`** (the graph *pauses* — `interrupt()` — zero
compute) → `observe` (LLM narrates + the cross-chain disclosure) → `decide` (LLM:
re-issue another window or stop). The backend's webhook resumes the graph from the
receiver thread; both `settlement.confirmed` and `intent.timeout` wake it.

### LangGraph Studio (verified)

```bash
cd agent && .venv/bin/langgraph dev        # local API on :2024 (needs langgraph-cli[inmem])
open "https://smith.langchain.com/studio/?baseUrl=http://127.0.0.1:2024"
```

Studio visualizes the graph parking on `wait_for_webhook` — the judges see the agent
waiting patiently. **Verified through the platform API:** a run created a real intent,
the thread state showed `task: wait_for_webhook · interrupts: ['monitoring']` (narration
unset — observe never ran), and a `Command(resume)` completed with the disclosure
narration. Notes: `studio.py` compiles WITHOUT a checkpointer (the dev server injects
its own persistence and rejects custom ones); the demo runner keeps its MemorySaver.

### The shareable results page

The demo prints `report page: <url>/w/<intent-id>` — a human-readable rendering of the
watch (events table with mainnet explorer links, settlement receipt with the Base
Sepolia link, the cross-chain disclosure). Served by the backend at `/w/:id`; the same
page deploys to Netlify (`npx netlify deploy --prod --dir web` from the repo root) and
fetches any reachable API via `?api=<base>`.

### The LLM layer

`AGENT_LLM=opencode` (default: `scripted`). The opencode adapter talks to a running
`opencode serve` (`OPENCODE_SERVER_URL`, default `http://127.0.0.1:4096`) using your
existing opencode auth — **no API key needed**. The LLM only fills `plan`, `observe`,
`decide`; it never touches keys or signatures, and its worst case is the server-quoted
ceiling. `scripted` keeps every beat runnable with zero LLM (CI, keyless demos).
