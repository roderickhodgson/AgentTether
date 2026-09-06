"""Permit2 allowance bootstrap (Phase 5.2a) — capability-detect, don't assume.

The x402 `upto` voucher authorizes Permit2 to pull USDC; before the first flow the
agent's USDC must be approved FOR Permit2. Three-way branch, cheap path first:

  1. Pre-check (every run — the allowance DECREMENTS per settlement, so the cache is
     only a fast path, never the source of truth).
  2. Gasless: if the facilitator advertises `eip2612GasSponsoring`, sign an EIP-2612
     `permit` (no ETH needed); how it attaches to the x402 flow is resolved by the
     5.2 live spike — until then the report carries the signed permit for the caller.
  3. Self-funded: broadcast `USDC.approve(PERMIT2, amount)` from the agent's own ETH.
     No ETH → fail fast with a faucet pointer, mid-demo surprises are the enemy.
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Any, Protocol

from .config import PERMIT2, Config

# Minimal USDC surface (EIP-20 + EIP-2612).
USDC_ABI = [
    {
        "name": "allowance",
        "type": "function",
        "stateMutability": "view",
        "inputs": [{"name": "owner", "type": "address"}, {"name": "spender", "type": "address"}],
        "outputs": [{"type": "uint256"}],
    },
    {
        "name": "approve",
        "type": "function",
        "stateMutability": "nonpayable",
        "inputs": [{"name": "spender", "type": "address"}, {"name": "amount", "type": "uint256"}],
        "outputs": [{"type": "bool"}],
    },
    {
        "name": "nonces",
        "type": "function",
        "stateMutability": "view",
        "inputs": [{"name": "owner", "type": "address"}],
        "outputs": [{"type": "uint256"}],
    },
]

ETH_ABI = [{"name": "balance", "type": "function", "stateMutability": "view", "inputs": [{"type": "address"}], "outputs": [{"type": "uint256"}]}]

GAS_SPONSORING_EXTENSIONS = ("eip2612GasSponsoring", "erc20ApprovalGasSponsoring")


class Web3Like(Protocol):
    """The slice of web3.py the bootstrapper uses (mocked in tests)."""

    eth: Any


class FacilitatorLike(Protocol):
    def supported_extensions(self) -> list[str]: ...


class FundError(RuntimeError):
    pass


@dataclass
class AllowanceReport:
    sufficient: bool
    allowance: int
    # Present when a fresh gasless permit was signed (branch 2) — the caller attaches
    # it per the extension spec once the 5.2 spike fixes the wire shape.
    permit: dict[str, Any] | None = None
    # True when the self-funded approve transaction was broadcast (branch 3).
    broadcast: bool = False
    cached: bool = False


class AllowanceBootstrapper:
    def __init__(self, config: Config, w3: Web3Like, facilitator: FacilitatorLike) -> None:
        self.config = config
        self.w3 = w3
        self.facilitator = facilitator
        self.usdc = w3.eth.contract(address=config.usdc_address, abi=USDC_ABI)

    # ── branch 1: cheap pre-check ───────────────────────────────────────────
    def allowance(self) -> int:
        return int(self.usdc.functions.allowance(self.config.wallet, PERMIT2).call())

    def cached_ok(self) -> bool:
        """Fast path only — the on-chain check still runs every `ensure`."""
        try:
            state = json.loads(self.config.state_path.read_text())
        except (OSError, ValueError):
            return False
        return (
            state.get("wallet") == self.config.wallet
            and state.get("permit2") == PERMIT2
            and state.get("ok_until", 0) > time.time()
        )

    def _mark_cached(self) -> None:
        self.config.state_path.write_text(
            json.dumps({"wallet": self.config.wallet, "permit2": PERMIT2, "ok_until": time.time() + 300})
        )

    # ── the three-way branch ────────────────────────────────────────────────
    def ensure(self, min_amount: int) -> AllowanceReport:
        current = self.allowance()
        if current >= min_amount:
            self._mark_cached()
            return AllowanceReport(sufficient=True, allowance=current, cached=self.cached_ok())

        extensions = self.facilitator.supported_extensions()

        # branch 2: gasless — sign an EIP-2612 permit the facilitator can batch.
        if any(ext in extensions for ext in GAS_SPONSORING_EXTENSIONS):
            permit = self.sign_eip2612_permit(PERMIT2, min_amount)
            return AllowanceReport(sufficient=False, allowance=current, permit=permit)

        # branch 3: self-funded — broadcast the approval ourselves.
        if int(self.w3.eth.get_balance(self.config.wallet)) == 0:
            raise FundError(
                f"{self.config.wallet} has USDC but no Base Sepolia ETH to broadcast the Permit2 "
                "approval, and the facilitator does not advertise gas sponsoring. Fund it at "
                "https://www.coinbase.com/faucets/base-eth-sepolia-faucet (or any Base Sepolia faucet)."
            )
        tx = self.usdc.functions.approve(PERMIT2, min_amount).build_transaction(
            {
                "from": self.config.wallet,
                "type": "0x2",  # EIP-1559 — sign_transaction needs the type to pick the field set
                "nonce": int(self.w3.eth.get_transaction_count(self.config.wallet)),
                "gas": 60_000,
                "maxFeePerGas": self.w3.eth.gas_price * 2,
                "maxPriorityFeePerGas": 10**8,
            }
        )
        signed = self._sign(tx)
        self.w3.eth.send_raw_transaction(signed)
        return AllowanceReport(sufficient=False, allowance=current, broadcast=True)

    # ── branch 2 helper: EIP-2612 permit signature ──────────────────────────
    def sign_eip2612_permit(self, spender: str, amount: int, deadline_s: int = 3600) -> dict[str, Any]:
        """Sign `permit(owner, spender, value, nonce, deadline)` for the USDC domain.

        Base Sepolia USDC domain: {name: "USDC", version: "2"} (canonical EIP-3009
        token metadata — the same domain the payment vouchers use).
        """
        from eth_account.messages import encode_typed_data

        account = self._account()
        nonce = int(self.usdc.functions.nonces(account.address).call())
        deadline = int(self.w3.eth.get_block("latest")["timestamp"]) + deadline_s
        typed = encode_typed_data(
            full_message={
                "types": {
                    "EIP712Domain": [
                        {"name": "name", "type": "string"},
                        {"name": "version", "type": "string"},
                        {"name": "chainId", "type": "uint256"},
                        {"name": "verifyingContract", "type": "address"},
                    ],
                    "Permit": [
                        {"name": "owner", "type": "address"},
                        {"name": "spender", "type": "address"},
                        {"name": "value", "type": "uint256"},
                        {"name": "nonce", "type": "uint256"},
                        {"name": "deadline", "type": "uint256"},
                    ],
                },
                "primaryType": "Permit",
                "domain": {"name": "USDC", "version": "2", "chainId": 84532, "verifyingContract": self.config.usdc_address},
                "message": {
                    "owner": account.address,
                    "spender": spender,
                    "value": amount,
                    "nonce": nonce,
                    "deadline": deadline,
                },
            }
        )
        signed = account.sign_message(typed)
        return {
            "owner": account.address,
            "spender": spender,
            "value": amount,
            "nonce": nonce,
            "deadline": deadline,
            "signature": "0x" + signed.signature.hex(),
        }

    def _sign(self, tx: dict[str, Any]) -> bytes:
        from eth_account import Account

        return Account.sign_transaction(tx, self.config.private_key).raw_transaction

    def _account(self):
        from eth_account import Account

        return Account.from_key(self.config.private_key)
