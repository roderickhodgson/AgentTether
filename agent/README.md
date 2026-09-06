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

### LangGraph Studio

```bash
cd agent && .venv/bin/langgraph dev   # attaches to agent/langgraph.json → studio.py:graph
```

Studio visualizes the graph parking on `wait_for_webhook` — the judges see the agent
waiting patiently. Studio is a viewer for this demo; the runner owns the process.

### The LLM layer

`AGENT_LLM=opencode` (default: `scripted`). The opencode adapter talks to a running
`opencode serve` (`OPENCODE_SERVER_URL`, default `http://127.0.0.1:4096`) using your
existing opencode auth — **no API key needed**. The LLM only fills `plan`, `observe`,
`decide`; it never touches keys or signatures, and its worst case is the server-quoted
ceiling. `scripted` keeps every beat runnable with zero LLM (CI, keyless demos).
