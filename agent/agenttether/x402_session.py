"""A single requests.Session that pays any x402 402 (stream `upto` + oneshot `exact`).

Both schemes are registered for the payment network, so the SDK's 402 handling picks
the right scheme from the response's requirements — the agent code never signs by hand
on the happy path (the 5.2 fallback of hand-rolled eth_account signing only applies if
the Python SDK's upto parity fails live).

The session also records the last quoted ceiling (the 402's requirements.amount) —
the client's worst-case spend, surfaced in the agent's narration.
"""
from __future__ import annotations

import requests
from eth_account import Account

from .config import Config


class QuotedCeiling:
    """Records the most recent 402 quote — the client's worst case, per flow."""

    def __init__(self) -> None:
        self.last: str | None = None


def x402_session(config: Config) -> tuple[requests.Session, QuotedCeiling]:
    from x402 import x402ClientSync
    from x402.http import x402HTTPClientSync
    from x402.http.clients.requests import wrapRequestsWithPayment
    from x402.mechanisms.evm.exact import ExactEvmScheme
    from x402.mechanisms.evm.upto import UptoEvmScheme

    account = Account.from_key(config.private_key)
    client = x402ClientSync()
    client.register(config.network, UptoEvmScheme(account))  # /stream vouchers
    client.register(config.network, ExactEvmScheme(account))  # /oneshot flat fee

    quote = QuotedCeiling()
    http_client = x402HTTPClientSync(client)

    def record_quote(ctx) -> None:
        req = ctx.payment_required
        accepts = getattr(req, "accepts", None) or []
        amounts = [str(getattr(a, "amount", "") or "") for a in accepts]
        quote.last = next((a for a in amounts if a), None)

    http_client.on_payment_required(record_quote)
    session = wrapRequestsWithPayment(requests.Session(), http_client)
    return session, quote
