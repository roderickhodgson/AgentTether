"""Unit tests for the agent config (5.1): env parsing, key derivation, defaults."""
from __future__ import annotations

import pytest

from agenttether.config import PERMIT2, load_config

KEY = "0x" + "11" * 32  # arbitrary test key


def base_env(**over: str) -> dict[str, str]:
    env = {"EVM_PRIVATE_KEY": KEY}
    env.update(over)
    return env


def test_defaults():
    cfg = load_config(base_env())
    assert cfg.server_url == "http://localhost:8080"
    assert cfg.facilitator_url == "https://x402.org/facilitator"
    assert cfg.rpc_url == "https://sepolia.base.org"
    assert cfg.network == "eip155:84532"
    assert cfg.usdc_address == "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
    assert cfg.webhook_port == 9098
    assert cfg.max_ttl_s == 60
    assert PERMIT2 == "0x000000000022D473030F116dDEE9F6B43aC78BA3"


def test_wallet_derives_from_key_unless_pinned():
    cfg = load_config(base_env())
    assert cfg.wallet.startswith("0x") and len(cfg.wallet) == 42
    assert cfg.wallet != KEY  # it's the ADDRESS, not the key

    derived = cfg.wallet
    pinned = load_config(base_env(AGENT_WALLET=derived))
    assert pinned.wallet == derived


def test_pinned_wallet_must_match_the_key():
    with pytest.raises(RuntimeError, match="does not match"):
        load_config(base_env(AGENT_WALLET="0x91Accc3A4fdaf197972b081A5c20A0037e0dB342"))


def test_missing_key_fails_fast():
    with pytest.raises(RuntimeError, match="EVM_PRIVATE_KEY"):
        load_config({})


def test_private_key_normalization():
    cfg = load_config({"EVM_PRIVATE_KEY": "ab" * 32})  # bare hex, no 0x
    assert cfg.private_key.startswith("0x")


def test_llm_provider_default_is_scripted():
    cfg = load_config(base_env())
    assert cfg.llm_provider == "scripted"
    assert cfg.opencode_url == "http://127.0.0.1:4096"
