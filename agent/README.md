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
