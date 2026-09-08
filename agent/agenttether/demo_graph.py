"""Composition root for the demo graph: config → paid session → graph.

Kept import-light and side-effect-free except for the paid session construction, so
`langgraph dev` (Studio) can attach to the same factory. The checkpointer is in-memory
— the demo is a single process, and the pause lives in that process; the webhook
server + resume hook live in the runner (scripts/demo_agent.py).
"""
from __future__ import annotations

from typing import Any

from langgraph.checkpoint.memory import MemorySaver

from .config import Config, load_config
from .graph import DEFAULT_WATCH, build_graph
from .llm import create_llm
from .stream_client import StreamClient
from .x402_session import x402_session

_AUTO = object()  # sentinel: runner default (in-process MemorySaver)


class DemoStack:
    """Everything the agent needs, built once: config, paid session, graph.

    `checkpointer`: pass an explicit one (default: MemorySaver for the single-process
    demo), or None to compile WITHOUT one — that's the LangGraph dev/Studio context,
    where the platform injects its own persistence and rejects custom checkpointers.
    """

    def __init__(
        self,
        config: Config | None = None,
        checkpointer: Any | None = _AUTO,
        webhook_url: str = "http://127.0.0.1:9098/hook",
        default_watch: dict[str, Any] | None = None,
    ) -> None:
        self.config = config or load_config()
        self.session, self.quote = x402_session(self.config)
        self.stream = StreamClient(self.session, self.config.server_url)
        self.llm = create_llm(self.config)
        if checkpointer is _AUTO:
            checkpointer = MemorySaver()
        self.checkpointer = checkpointer
        self.graph = build_graph(
            self.stream,
            self.llm,
            self.checkpointer,
            webhook_url=webhook_url,
            default_watch=default_watch or DEFAULT_WATCH,
            quote_source=lambda: self.quote.last,
            annotate=self._annotate,
        )

    def _annotate(self, job_id: str, step: str, **detail) -> None:
        """Best-effort flow-chart annotation — the backend chart gains the agent's own
        LLM rows (plan / observe / decide). Failures never kill the run."""
        try:
            self.session.post(  # the wrapped session also works for plain calls
                f"{self.config.server_url}/api/v1/intents/{job_id}/annotate",
                json={"step": step, "detail": detail},
                timeout=10,
            )
        except Exception:  # noqa: BLE001
            pass
