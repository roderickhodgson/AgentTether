"""A single requests.Session that pays any x402 402 (stream `upto` + oneshot `exact`).

Both schemes are registered for the payment network, so the SDK's 402 handling picks
the right scheme from the response's requirements — the agent code never signs by hand
on the happy path (the 5.2 fallback of hand-rolled eth_account signing only applies if
the Python SDK's upto parity fails live).
"""
from __future__ import annotations

import requests
from eth_account import Account

from .config import Config


def x402_session(config: Config) -> requests.Session:
    from x402 import x402ClientSync
    from x402.http.clients.requests import wrapRequestsWithPayment
    from x402.mechanisms.evm.exact import ExactEvmScheme
    from x402.mechanisms.evm.upto import UptoEvmScheme

    account = Account.from_key(config.private_key)
    client = x402ClientSync()
    client.register(config.network, UptoEvmScheme(account))  # /stream vouchers
    client.register(config.network, ExactEvmScheme(account))  # /oneshot flat fee
    return wrapRequestsWithPayment(requests.Session(), client)
