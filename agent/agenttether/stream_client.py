"""Stream intent client (5.3/5.4): POST /api/v1/intents/stream through the x402 flow.

The request goes out plain → the backend answers 402 with the quoted ceiling (upto,
Permit2, facilitator-bound witness) → the wrapped session signs the voucher with the
Python SDK's UptoEvmScheme and retries with PAYMENT-SIGNATURE → 202 with the job id.
Pricing fields are NEVER sent (server-owned; the backend 400s them).
"""
from __future__ import annotations

from typing import Any

import requests

STREAM_PATH = "/api/v1/intents/stream"


class StreamIntentError(RuntimeError):
    pass


class StreamClient:
    def __init__(self, session: requests.Session, server_url: str) -> None:
        self.session = session
        self.server_url = server_url.rstrip("/")

    def build_body(
        self,
        target_contract: str | None,
        min_amount_atomic: str | None,
        ttl_seconds: int,
        webhook_url: str | None,
        query_intent: str,
        watch_wallet: str | None = None,
        direction: str | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"query_intent": query_intent}
        if target_contract:
            body["target_contract"] = target_contract
        if watch_wallet:
            body["watch_wallet"] = watch_wallet
        if direction:
            body["direction"] = direction
        body["event_condition"] = {"minAmount": min_amount_atomic} if min_amount_atomic else {}
        body["ttl_seconds"] = ttl_seconds
        if webhook_url:
            body["webhook_url"] = webhook_url
        return body

    def create_intent(
        self,
        target_contract: str | None,
        min_amount_atomic: str | None,
        ttl_seconds: int,
        webhook_url: str | None = None,
        query_intent: str = "agent watch",
        watch_wallet: str | None = None,
        direction: str | None = None,
    ) -> dict[str, Any]:
        """Create the intent; 402→voucher→202 happens inside the wrapped session.

        Returns the 202 payload: {job_id, status, agent_wallet, report_url, ...}.
        `report_url` is the BACKEND's own link (built from its PUBLIC_SITE_URL) — the
        web tier that matches the API the agent is talking to. A wallet watch
        (watch_wallet + optional direction/target_contract) replaces the asset-only
        form; min_amount_atomic=None means any transfer.
        """
        res = self.session.post(
            f"{self.server_url}{STREAM_PATH}",
            json=self.build_body(
                target_contract, min_amount_atomic, ttl_seconds, webhook_url, query_intent,
                watch_wallet=watch_wallet, direction=direction,
            ),
            timeout=120,
        )
        if res.status_code != 202:
            raise StreamIntentError(f"expected 202, got {res.status_code}: {res.text[:300]}")
        data = res.json()
        if "job_id" not in data:
            raise StreamIntentError(f"202 without job_id: {data}")
        return data
