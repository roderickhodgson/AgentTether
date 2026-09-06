"""Unit tests for the Permit2 allowance bootstrap (5.2a) — all three branches, offline."""
from __future__ import annotations

import json

import pytest
from eth_account import Account

from agenttether.allowance import GAS_SPONSORING_EXTENSIONS, AllowanceBootstrapper, FundError
from agenttether.config import load_config

KEY = "0x" + "11" * 32
WALLET = Account.from_key(KEY).address  # the address the test key actually controls
USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3"
MIN = 92_900  # a quoted stream ceiling


class FakeContractFn:
    def __init__(self, value):
        self._value = value

    def call(self):
        return self._value

    def build_transaction(self, tx):
        return dict(tx)  # real web3 merges the caller's fields — echo them


class FakeUsdc:
    def __init__(self, allowance_value: int, nonce: int = 0):
        self._allowance = allowance_value
        self._nonce = nonce
        self.approved: list[tuple[str, int]] = []

    def functions(self):
        return self


class FakeEth:
    def __init__(self, usdc: FakeUsdc, eth_balance: int = 10**16):
        self._usdc = usdc
        self._eth_balance = eth_balance
        self.gas_price = 10**9
        self.sent: list[bytes] = []
        self.eth = self  # the bootstrapper reaches contract() through w3.eth

    def contract(self, address: str, abi):
        assert address == USDC
        return self._usdc

    def get_balance(self, _addr) -> int:
        return self._eth_balance

    def get_transaction_count(self, _addr) -> int:
        return 0

    def get_block(self, _block):
        return {"timestamp": 1_700_000_000}

    def send_raw_transaction(self, raw: bytes):
        self.sent.append(raw)


class FakeUsdcContract:
    """Stands in for `w3.eth.contract(...)` — functions.* accessors."""

    def __init__(self, allowance_value: int, nonce: int = 0):
        self._allowance = allowance_value
        self._nonce = nonce
        self.approve_calls: list[tuple[str, int]] = []

    @property
    def functions(self):
        return self

    def allowance(self, _owner, _spender):
        return FakeContractFn(self._allowance)

    def nonces(self, _owner):
        return FakeContractFn(self._nonce)

    def approve(self, spender, amount):
        self.approve_calls.append((spender, amount))
        return FakeContractFn(True)


class FakeFacilitator:
    def __init__(self, extensions: list[str]):
        self.extensions = extensions

    def supported_extensions(self):
        return self.extensions


def make_bootstrapper(monkeypatch, allowance_value: int, extensions: list[str] | None = None, eth_balance: int = 10**16):
    extensions = extensions or []
    cfg = load_config({"EVM_PRIVATE_KEY": KEY, "AGENT_WALLET": WALLET, "AGENT_STATE_PATH": ""})
    usdc = FakeUsdcContract(allowance_value)
    w3 = FakeEth(usdc, eth_balance)
    # give the config a scratch state path
    cfg = type(cfg)(**{**cfg.__dict__, "state_path": json_path(monkeypatch)})
    return AllowanceBootstrapper(cfg, w3, FakeFacilitator(extensions)), usdc, w3


def json_path(monkeypatch, tmp_name="state.json"):
    import tempfile
    from pathlib import Path

    p = Path(tempfile.mkdtemp()) / tmp_name
    return p


def test_sufficient_allowance_is_a_no_op(monkeypatch):
    boot, usdc, w3 = make_bootstrapper(monkeypatch, MIN)
    report = boot.ensure(MIN)
    assert report.sufficient is True
    assert report.permit is None and report.broadcast is False
    assert usdc.approve_calls == [] and w3.sent == []
    assert boot.config.state_path.exists()  # cached for the next run


def test_cached_state_short_circuits_every_run_check_is_still_cheap(monkeypatch):
    boot, _, _ = make_bootstrapper(monkeypatch, MIN)
    boot.ensure(MIN)  # marks cached
    report = boot.ensure(MIN)
    assert report.cached is True  # the cache flag rides along; the chain read stays


def test_gasless_branch_signs_eip2612_permit_without_broadcast(monkeypatch):
    boot, usdc, w3 = make_bootstrapper(monkeypatch, allowance_value=0, extensions=list(GAS_SPONSORING_EXTENSIONS))
    report = boot.ensure(MIN)
    assert report.sufficient is False
    assert report.permit is not None
    permit = report.permit
    assert permit["owner"] == WALLET
    assert permit["spender"] == PERMIT2
    assert permit["value"] == MIN
    assert len(permit["signature"]) == 132  # 0x + 65-byte r||v||s
    assert usdc.approve_calls == [] and w3.sent == []  # nothing broadcast — the facilitator batches


def test_self_funded_branch_broadcasts_approve(monkeypatch):
    boot, usdc, w3 = make_bootstrapper(monkeypatch, allowance_value=0, extensions=[], eth_balance=10**16)
    report = boot.ensure(MIN)
    assert report.broadcast is True
    assert usdc.approve_calls == [(PERMIT2, MIN)]
    assert len(w3.sent) == 1


def test_unfunded_no_extension_fails_fast_with_faucet_pointer(monkeypatch):
    boot, _, _ = make_bootstrapper(monkeypatch, allowance_value=0, extensions=[], eth_balance=0)
    with pytest.raises(FundError, match="faucet"):
        boot.ensure(MIN)


def test_erc20_approval_sponsoring_also_counts_as_gasless(monkeypatch):
    boot, _, _ = make_bootstrapper(monkeypatch, allowance_value=0, extensions=["erc20ApprovalGasSponsoring"])
    report = boot.ensure(MIN)
    assert report.permit is not None
