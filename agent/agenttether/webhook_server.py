"""Agent-side webhook receiver (5.5) — and, in the LangGraph build, the resume endpoint.

The backend POSTs delivery/timeout notices to /hook; the server buffers them per
intent. Two consumers:
- the demo script polls `notices(intent_id)` (plain Python flow), and
- the graph resume path (commit 3): /hook → resolve intent → `Command(resume=...)`.

The backend's webhook contract (from the Node e2e): POST JSON, expects 200. Notices
carry `type` (settlement.confirmed | intent.timeout), `intent_id`, `tx_hash`,
`amount_charged_atomic`, `events_matched`, and `events` (the matched transfers).
"""
from __future__ import annotations

import threading
from typing import Any, Callable

from flask import Flask, jsonify, request

from .config import Config


class WebhookServer:
    def __init__(self, config: Config) -> None:
        self.config = config
        self._lock = threading.Lock()
        self._notices: dict[str, list[dict[str, Any]]] = {}
        self._callbacks: list[Callable[[dict[str, Any]], None]] = []
        self.app = Flask("agenttether-webhook")
        self.app.logger.disabled = True
        self._register_routes()

    # ── routes ──────────────────────────────────────────────────────────────
    def _register_routes(self) -> None:
        @self.app.post("/hook")
        def hook() -> Any:
            notice = request.get_json(silent=True) or {}
            intent_id = notice.get("intent_id")
            if intent_id:
                with self._lock:
                    self._notices.setdefault(intent_id, []).append(notice)
            # post-buffer callbacks (the graph resume) run outside the lock
            for cb in self._callbacks:
                try:
                    cb(notice)
                except Exception:  # noqa: BLE001 — the receiver must always 200
                    pass
            return jsonify(ok=True)

        @self.app.post("/resume/<intent_id>")
        def resume(intent_id: str) -> Any:
            """Manual/ops resume trigger — drains buffered notices for one intent.

            The graph build (commit 3) also auto-resumes on /hook; this endpoint keeps
            the demo recoverable if a webhook is missed.
            """
            with self._lock:
                drained = self._notices.pop(intent_id, [])
            return jsonify(notices=drained)

    # ── accessors ───────────────────────────────────────────────────────────
    def on_notice(self, callback: Callable[[dict[str, Any]], None]) -> None:
        """Register a post-buffer callback (e.g. the graph resume hook)."""
        self._callbacks.append(callback)

    def notices(self, intent_id: str, wait: bool = False, timeout: float = 0.0) -> list[dict[str, Any]]:
        """Buffered notices for an intent; optionally block until one arrives."""
        import time

        deadline = time.time() + timeout if wait else time.time()
        while True:
            with self._lock:
                batch = self._notices.pop(intent_id, None)
            if batch:
                return batch
            if not wait or time.time() >= deadline:
                return []
            time.sleep(0.2)

    def url(self) -> str:
        # AGENT_WEBHOOK_PUBLIC_URL overrides the loopback default: a DEPLOYED backend
        # can only reach this receiver through a public https tunnel (ngrok/cloudflared
        # — the backend's SSRF rule requires https for non-loopback webhook targets).
        public = self.config.webhook_public_url
        if public:
            return f"{public.rstrip('/')}/hook"
        return f"http://{self.config.webhook_host}:{self.config.webhook_port}/hook"

    def serve_forever(self) -> None:
        self.app.run(host=self.config.webhook_host, port=self.config.webhook_port, threaded=True)

    def serve_background(self) -> threading.Thread:
        thread = threading.Thread(target=self.serve_forever, daemon=True)
        thread.start()
        return thread


ResumeHook = Callable[[dict[str, Any]], None]
