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


class DemoStack:
    """Everything the agent needs, built once: config, paid session, graph."""

    def __init__(
        self,
        config: Config | None = None,
        checkpointer: Any | None = None,
        webhook_url: str = "http://127.0.0.1:9098/hook",
        default_watch: dict[str, Any] | None = None,
    ) -> None:
        self.config = config or load_config()
        self.session, self.quote = x402_session(self.config)
        self.stream = StreamClient(self.session, self.config.server_url)
        self.llm = create_llm(self.config)
        self.checkpointer = checkpointer or MemorySaver()
        self.graph = build_graph(
            self.stream,
            self.llm,
            self.checkpointer,
            webhook_url=webhook_url,
            default_watch=default_watch or DEFAULT_WATCH,
            quote_source=lambda: self.quote.last,
        )
