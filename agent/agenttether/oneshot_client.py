"""Oneshot client: POST /api/v1/intents/oneshot — flat fee, immediate response.

The wrapped session pays the 402's quoted flat fee (exact scheme, Base USDC) and the
200 body carries the lookback window + transfers.
"""
from __future__ import annotations

from typing import Any

import requests

ONESHOT_PATH = "/api/v1/intents/oneshot"


class OneshotError(RuntimeError):
    pass


class OneshotClient:
    def __init__(self, session: requests.Session, server_url: str) -> None:
        self.session = session
        self.server_url = server_url.rstrip("/")

    def build_body(
        self,
        target_contract: str,
        min_amount_atomic: str | None = None,
        lookback_blocks: int | None = None,
        limit: int | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"target_contract": target_contract}
        if min_amount_atomic is not None:
            body["min_amount_atomic"] = min_amount_atomic
        if lookback_blocks is not None:
            body["lookback_blocks"] = lookback_blocks
        if limit is not None:
            body["limit"] = limit
        return body

    def lookup(
        self,
        target_contract: str,
        min_amount_atomic: str | None = None,
        lookback_blocks: int | None = None,
        limit: int | None = None,
    ) -> dict[str, Any]:
        res = self.session.post(
            f"{self.server_url}{ONESHOT_PATH}",
            json=self.build_body(target_contract, min_amount_atomic, lookback_blocks, limit),
            timeout=120,
        )
        if res.status_code != 200:
            raise OneshotError(f"expected 200, got {res.status_code}: {res.text[:300]}")
        return res.json()
