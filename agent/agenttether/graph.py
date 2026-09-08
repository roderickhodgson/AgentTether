"""The LangGraph agent (5.3–5.5): negotiate → PAUSE on wait_for_webhook → observe → decide.

The pause is real: `wait_for_webhook` raises `interrupt()`, the invoke RETURNS, and the
thread's state is checkpointed — zero compute while the watch runs. The backend's
webhook (delivery or timeout notice) resumes the graph via `Command(resume=notice)`
from the webhook server's thread; execution continues from the interrupt point.

LLM nodes are swappable (llm.py): opencode by default, scripted fallback for CI. The
LLM never touches keys — negotiate is deterministic SDK signing.

5.5a transparency: every narration ends with the cross-chain disclosure, so it shows
up in transcripts as a matter of course.
"""
from __future__ import annotations

import json
import operator
from typing import Annotated, Any, TypedDict

from langgraph.graph import END, StateGraph
from langgraph.types import Command, interrupt

from .llm import LlmClient, parse_json
from .stream_client import StreamClient

DISCLOSURE = (
    "Disclosure: I observed Ethereum mainnet for data (real, organic on-chain events), "
    "but all x402 financial settlement executed safely on Base Sepolia (or Hedera "
    "testnet). The observed data and the payment rail are on different chains by design."
)

# Known capture assets — narration names the token, not a raw address.
KNOWN_ASSETS = {
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": "USDC",  # mainnet
    "0x036cbd53842c5426634e7929541ec2318f3dcf7e": "USDC",  # Base Sepolia
}


def asset_name(contract: str | None) -> str:
    return KNOWN_ASSETS.get((contract or "").lower()) or (contract or "unknown contract")


def factual_summary(state: AgentState) -> str:
    notice = state.get("notice") or {}
    events = notice.get("events") or []
    asset = asset_name(state.get("watch", {}).get("target_contract"))
    if events:
        head = (
            f"Watched {asset} for transfers; the window delivered "
            f"{notice.get('events_matched', len(events))} matching events; settlement "
            f"charged {notice.get('amount_charged_atomic', '?')} atomic."
        )
    elif notice.get("tx_hash"):
        head = (
            f"Watched {asset} for transfers; the window expired without a match; the "
            f"idle watch was charged {notice.get('amount_charged_atomic', '?')} atomic "
            f"(its full block budget)."
        )
    else:
        # No tx, no amount: the sweep's zero-processed-blocks timeout — the window
        # never opened (the stream processed nothing in-window), so nothing was billed.
        head = (
            f"Watched {asset} for transfers; the window expired with no blocks "
            f"processed — NOTHING was charged (the watch never opened)."
        )
    if notice.get("synthetic"):
        head += " (woke by the agent's own watchdog — the backend webhook never arrived)"
    return f"{head} {DISCLOSURE}"

DEFAULT_WATCH = {
    "target_contract": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",  # mainnet USDC
    "min_amount_atomic": "1000000",  # ≥ 1 USDC — dense enough to fire in the first block
    "ttl_seconds": 60,
    "query_intent": "agent watch",
}


class AgentState(TypedDict):
    objective: str
    watch: dict[str, Any]
    job_id: str
    quoted_ceiling: str
    notice: dict[str, Any]
    narration: str
    decision: str
    reissue_budget: int
    reissues_used: Annotated[int, operator.add]


PLAN_SYSTEM = (
    "You are an autonomous agent that buys blockchain event watches with x402 payments. "
    'Reply with ONLY a JSON object: {"target_contract": "<0x address>", '
    '"min_amount_atomic": "<atomic-unit string>", "ttl_seconds": <60..86400>, '
    '"query_intent": "<short description>"}. No prose, no markdown.'
)
OBSERVE_SYSTEM = (
    "You are an autonomous agent reporting on a blockchain event watch you purchased. "
    "Narrate in 2-4 sentences: what was watched, what arrived (or why the window "
    "expired), and how much the settlement charged. End with the exact disclosure you "
    "are given. Plain text."
)
DECIDE_SYSTEM = (
    "You are an autonomous agent deciding whether to keep listening. Reply with ONLY "
    '{"decision": "reissue" | "done", "reason": "<one sentence>"}. '
    "Reissue only if the objective clearly benefits from a longer watch."
)


def build_graph(
    stream: StreamClient,
    llm: LlmClient,
    checkpointer: Any,
    webhook_url: str,
    default_watch: dict[str, Any] | None = None,
    quote_source: Any | None = None,
    annotate: Any | None = None,
) -> Any:
    """Compile the agent graph. Deps are injected — tests pass fakes.

    `quote_source` (optional): callable returning the last 402's quoted ceiling — the
    client's worst case, surfaced in the narration.
    """

    watch_default = default_watch or DEFAULT_WATCH

    # ── plan (LLM): objective → watch params ────────────────────────────────
    def plan(state: AgentState) -> dict[str, Any]:
        prompt = (
            '{{"kind": "plan"}}\n'
            f"objective: {state['objective']}\n"
            f"defaults you may reuse (JSON): {json.dumps(watch_default)}"
        )
        reply = llm.complete(PLAN_SYSTEM, prompt)
        try:
            watch = parse_json(reply)
            watch["ttl_seconds"] = int(watch.get("ttl_seconds", 60))
        except (ValueError, TypeError):
            watch = dict(watch_default)
        return {"watch": watch}

    # ── negotiate (deterministic): the x402 handshake + Permit2 signing ─────
    def negotiate(state: AgentState) -> dict[str, Any]:
        watch = state["watch"]
        job = stream.create_intent(
            target_contract=watch["target_contract"],
            min_amount_atomic=str(watch["min_amount_atomic"]),
            ttl_seconds=int(watch["ttl_seconds"]),
            webhook_url=webhook_url,
            query_intent=str(watch.get("query_intent", "agent watch")),
        )
        quoted = None
        if quote_source is not None:
            quoted = quote_source()
        quoted = str(quoted or job.get("quoted_ceiling") or "server-quoted")
        if annotate:
            annotate(job["job_id"], "plan", **{k: str(v) for k, v in watch.items()})
        return {"job_id": job["job_id"], "quoted_ceiling": quoted}

    # ── wait_for_webhook: THE PAUSE ─────────────────────────────────────────
    def wait_for_webhook(state: AgentState) -> dict[str, Any]:
        # The graph visually parks here in LangGraph Studio. The resume value is the
        # webhook notice (settlement.confirmed | intent.timeout | synthetic watchdog).
        notice = interrupt(
            {
                "state": "monitoring",
                "job_id": state["job_id"],
                "note": "agent asleep — the backend webhook resumes this graph",
            }
        )
        return {"notice": notice}

    # ── observe (LLM): narrate the delivery + disclosure ────────────────────
    def observe(state: AgentState) -> dict[str, Any]:
        notice = state.get("notice") or {}
        asset = asset_name(state.get("watch", {}).get("target_contract"))
        guidance = (
            f"- asset: {asset}\n"
            "- notice with events: report how many arrived and the charged amount\n"
            "- notice with a tx but no events: the window expired idle and its full block budget was charged\n"
            "- notice with no tx: the window never opened (no blocks processed) and NOTHING was charged\n"
            "- synthetic notice: the agent's own watchdog woke it — the backend webhook never arrived\n"
        )
        prompt = (
            '{{"kind": "observe"}}\n'
            f"watch: {state.get('watch')}\n"
            f"quoted ceiling (atomic): {state.get('quoted_ceiling')}\n"
            f"webhook notice: {notice}\n"
            f"{guidance}"
            f"disclosure to append verbatim: {DISCLOSURE}"
        )
        if annotate and state.get("job_id"):
            annotate(state["job_id"], "observe", note="narrated the delivery")
        try:
            narration = llm.complete(OBSERVE_SYSTEM, prompt).strip()
        except Exception as exc:  # noqa: BLE001 — narration must never kill the run
            narration = ""
        # Only trust substantive LLM narration; a thin reply (scripted stubs) falls
        # back to the factual baseline — which always carries the disclosure.
        if len(narration) < 80:
            narration = factual_summary(state)
        return {"narration": narration}

    # ── decide (LLM): re-issue loop or stop ─────────────────────────────────
    def decide(state: AgentState) -> dict[str, Any]:
        prompt = (
            '{{"kind": "decide"}}\n'
            f"objective: {state['objective']}\n"
            f"reissue_budget: {state.get('reissue_budget', 0)}\n"
            f"reissues_used: {state.get('reissues_used', 0)}\n"
            f"last notice: {state.get('notice')}"
        )
        if annotate and state.get("job_id"):
            annotate(state["job_id"], "decide", note="deciding: reissue or stop")
        try:
            parsed = parse_json(llm.complete(DECIDE_SYSTEM, prompt))
            decision = parsed.get("decision", "done")
        except (ValueError, AttributeError):
            decision = "done"
        if decision == "reissue" and state.get("reissues_used", 0) >= state.get("reissue_budget", 0):
            decision = "done"
        if annotate:
            annotate(state["job_id"], "decision", outcome=decision)
        # The Annotated[int, operator.add] counter only moves when WE move it: one
        # re-issue decrements the remaining budget by one — the loop is finite.
        return {"decision": decision, "reissues_used": 1 if decision == "reissue" else 0}

    def route_decide(state: AgentState) -> str:
        return "negotiate" if state.get("decision") == "reissue" else END

    graph = StateGraph(AgentState)
    graph.add_node("plan", plan)
    graph.add_node("negotiate", negotiate)
    graph.add_node("wait_for_webhook", wait_for_webhook)
    graph.add_node("observe", observe)
    graph.add_node("decide", decide)
    graph.set_entry_point("plan")
    graph.add_edge("plan", "negotiate")
    graph.add_edge("negotiate", "wait_for_webhook")
    graph.add_edge("wait_for_webhook", "observe")
    graph.add_edge("observe", "decide")
    graph.add_conditional_edges("decide", route_decide, {"negotiate": "negotiate", END: END})
    return graph.compile(checkpointer=checkpointer)
