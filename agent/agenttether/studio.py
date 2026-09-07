"""Studio attachment point — `langgraph dev` loads this module's `graph`.

Importing builds the full demo stack (config → paid x402 session → compiled graph).
The webhook URL defaults to the local receiver; the runner (scripts/demo_agent.py) is
still the composition root for actual runs — this module exists so LangGraph Studio
can visualize the same graph definition, including the wait_for_webhook pause.
"""
from __future__ import annotations

try:
    from .demo_graph import DemoStack
except ImportError:  # `langgraph dev` loads this file as a top-level module
    from agenttether.demo_graph import DemoStack

# checkpointer=None: the dev server injects its own persistence and rejects custom ones.
graph = DemoStack(checkpointer=None).graph  # noqa: E305 — module-level graph for langgraph.json
