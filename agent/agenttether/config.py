"""AgentTether agent client — configuration.

Phase 5 (5.1). The agent is the Python half of the product: it reads the repo-root
`.env` (gitignored, shared with the backend daemon — one source of truth), derives the
wallet address from the private key, and carries the wire constants (Permit2 canonical
address, Base Sepolia USDC). Server-side pricing knobs are deliberately absent: pricing
is server-owned (5.6's client can't set rates; here it can't even see them).
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[2]

# Canonical Permit2 contract (same address on every chain).
PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3"


@dataclass(frozen=True)
class Config:
    server_url: str
    facilitator_url: str
    rpc_url: str
    network: str
    usdc_address: str
    private_key: str
    wallet: str
    webhook_host: str
    webhook_port: int
    max_ttl_s: int
    state_path: Path
    opencode_url: str = ""
    llm_provider: str = "scripted"
    extras: dict[str, str] = field(default_factory=dict)


def load_config(env: dict[str, str] | None = None) -> Config:
    """Build the agent config. `env` overrides os.environ (tests inject their own)."""
    if env is None:
        load_dotenv(REPO_ROOT / ".env")
        env = os.environ

    pk = env.get("EVM_PRIVATE_KEY", "")
    if not pk:
        raise RuntimeError("EVM_PRIVATE_KEY is required (repo-root .env)")
    if not pk.startswith("0x"):
        pk = "0x" + pk

    # Derive the agent wallet from the key unless one is pinned explicitly — and fail
    # fast on a pin/key mismatch: signatures silently disagree with a wrong pin.
    from eth_account import Account

    wallet = env.get("AGENT_WALLET") or Account.from_key(pk).address
    derived = Account.from_key(pk).address
    if wallet.lower() != derived.lower():
        raise RuntimeError(f"AGENT_WALLET ({wallet}) does not match EVM_PRIVATE_KEY ({derived})")

    return Config(
        server_url=env.get("SERVER_URL", "http://localhost:8080").rstrip("/"),
        facilitator_url=env.get("FACILITATOR_URL", "https://x402.org/facilitator").rstrip("/"),
        rpc_url=env.get("RPC_URL", "https://sepolia.base.org"),
        network=env.get("NETWORK", "eip155:84532"),
        usdc_address=env.get("USDC_ADDRESS", "0x036CbD53842c5426634e7929541eC2318f3dCF7e"),
        private_key=pk,
        wallet=wallet,
        webhook_host=env.get("AGENT_WEBHOOK_HOST", "127.0.0.1"),
        webhook_port=int(env.get("AGENT_WEBHOOK_PORT", "9098")),
        max_ttl_s=int(env.get("AGENT_MAX_TTL_S", "60")),
        state_path=Path(env.get("AGENT_STATE_PATH", str(REPO_ROOT / "agent" / "state.json"))),
        opencode_url=env.get("OPENCODE_SERVER_URL", "http://127.0.0.1:4096").rstrip("/"),
        llm_provider=env.get("AGENT_LLM", "scripted"),
    )
