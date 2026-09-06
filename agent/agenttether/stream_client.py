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
        target_contract: str,
        min_amount_atomic: str,
        ttl_seconds: int,
        webhook_url: str | None,
        query_intent: str,
    ) -> dict[str, Any]:
        return {
            "query_intent": query_intent,
            "target_contract": target_contract,
            "event_condition": {"minAmount": min_amount_atomic},
            "ttl_seconds": ttl_seconds,
            **({"webhook_url": webhook_url} if webhook_url else {}),
        }

    def create_intent(
        self,
        target_contract: str,
        min_amount_atomic: str,
        ttl_seconds: int,
        webhook_url: str | None = None,
        query_intent: str = "agent watch",
    ) -> dict[str, Any]:
        """Create the intent; 402→voucher→202 happens inside the wrapped session.

        Returns the 202 payload: {job_id, status, agent_wallet, ...}.
        """
        res = self.session.post(
            f"{self.server_url}{STREAM_PATH}",
            json=self.build_body(target_contract, min_amount_atomic, ttl_seconds, webhook_url, query_intent),
            timeout=120,
        )
        if res.status_code != 202:
            raise StreamIntentError(f"expected 202, got {res.status_code}: {res.text[:300]}")
        data = res.json()
        if "job_id" not in data:
            raise StreamIntentError(f"202 without job_id: {data}")
        return data
