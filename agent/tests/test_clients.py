"""Unit tests for the stream/oneshot clients + webhook server — offline."""
from __future__ import annotations

import json

import pytest
import requests

from agenttether.oneshot_client import OneshotClient
from agenttether.stream_client import StreamClient, StreamIntentError
from agenttether.webhook_server import WebhookServer


class FakeResponse:
    def __init__(self, status_code: int, payload: dict | None = None, text: str = ""):
        self.status_code = status_code
        self._payload = payload or {}
        self.text = text or json.dumps(self._payload)

    def json(self):
        return self._payload


class FakeSession:
    def __init__(self, responses: list[FakeResponse]):
        self.responses = responses
        self.calls: list[tuple[str, str, dict | None]] = []

    def post(self, url: str, json: dict | None = None, timeout: int | None = None) -> FakeResponse:
        self.calls.append(("POST", url, json))
        return self.responses.pop(0)


def test_stream_body_shape_never_carries_pricing():
    client = StreamClient(FakeSession([]), "http://x:8080")
    body = client.build_body("0xabc", "1000000000", 60, "http://127.0.0.1:9098/hook", "watch whales")
    assert body == {
        "query_intent": "watch whales",
        "target_contract": "0xabc",
        "event_condition": {"minAmount": "1000000000"},
        "ttl_seconds": 60,
        "webhook_url": "http://127.0.0.1:9098/hook",
    }
    assert "rate_per_event_atomic" not in body and "max_limit_atomic" not in body


def test_create_intent_returns_job_id_on_202():
    session = FakeSession([FakeResponse(202, {"job_id": "j-1", "status": "MONITORING", "agent_wallet": "0xw"})])
    client = StreamClient(session, "http://x:8080")
    out = client.create_intent("0xabc", "1", 60, None, "q")
    assert out["job_id"] == "j-1"
    assert session.calls[0][1] == "http://x:8080/api/v1/intents/stream"


def test_create_intent_raises_on_unexpected_status():
    session = FakeSession([FakeResponse(400, {"error": "invalid intent"})])
    with pytest.raises(StreamIntentError, match="400"):
        StreamClient(session, "http://x:8080").create_intent("0xabc", "1", 60)


def test_oneshot_body_omits_unset_fields():
    client = OneshotClient(FakeSession([]), "http://x:8080")
    assert client.build_body("0xabc") == {"target_contract": "0xabc"}
    full = client.build_body("0xabc", "1000000", 300, 10)
    assert full == {
        "target_contract": "0xabc",
        "min_amount_atomic": "1000000",
        "lookback_blocks": 300,
        "limit": 10,
    }


def test_oneshot_lookup_parses_window():
    session = FakeSession([FakeResponse(200, {"window": {"fromBlock": 1, "toBlock": 300}, "transfers": []})])
    out = OneshotClient(session, "http://x:8080").lookup("0xabc", "1000000")
    assert out["window"]["toBlock"] == 300


def test_webhook_server_buffers_by_intent_and_resume_drains():
    cfg_webhook = WebhookServer.__new__(WebhookServer)  # skip __init__'s config use
    cfg_webhook._lock = __import__("threading").Lock()
    cfg_webhook._notices = {}
    cfg_webhook._callbacks = []
    cfg_webhook.app = __import__("flask").Flask("test")
    cfg_webhook._register_routes()
    client = cfg_webhook.app.test_client()

    notice = {"type": "intent.delivered", "intent_id": "j-1", "tx_hash": "0xtx", "events_matched": 2}
    res = client.post("/hook", json=notice)
    assert res.status_code == 200 and res.json == {"ok": True}
    # unparseable bodies don't wedge the receiver
    assert client.post("/hook", data="not json", content_type="application/json").status_code == 200

    res = client.post("/resume/j-1")
    assert res.json["notices"] == [notice]
    assert client.post("/resume/j-1").json["notices"] == []  # drained
    assert client.post("/resume/unknown").json["notices"] == []


def test_webhook_notices_accessor():
    server = WebhookServer.__new__(WebhookServer)
    server._lock = __import__("threading").Lock()
    server._notices = {"j-2": [{"intent_id": "j-2"}]}
    server._callbacks = []
    assert server.notices("j-2") == [{"intent_id": "j-2"}]
    assert server.notices("j-2", wait=False) == []
