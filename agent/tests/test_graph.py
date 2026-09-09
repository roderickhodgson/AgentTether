"""Unit tests for the LangGraph agent — pause/resume semantics, offline (fakes only).

The pause is the product: invoke returns at wait_for_webhook (zero compute), and a
Command(resume=notice) continues from the interrupt point. These tests prove:
- the graph parks on the interrupt and does NOT observe/decide yet,
- resume carries the notice through observe (with the 5.5a disclosure) to decide,
- the scripted re-issue loop re-enters negotiate (a second voucher),
- the watchdog-style synthetic timeout resumes cleanly.
"""
from __future__ import annotations

from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command

from agenttether.graph import DISCLOSURE, build_graph
from agenttether.llm import ScriptedLlm

DELIVERED = {
    "type": "settlement.confirmed",
    "intent_id": "j-1",
    "tx_hash": "0xsettle",
    "amount_charged_atomic": "100",
    "events_matched": 2,
    "events": [{"block": 1, "amount_atomic": "2000000"}],
}
TIMEOUT = {
    "type": "intent.timeout",
    "intent_id": "j-1",
    "tx_hash": "0xsettle-full",
    "amount_charged_atomic": "500",
    "events_matched": 0,
}


class FakeStream:
    def __init__(self):
        self.calls = 0

    def create_intent(self, **_kw):
        self.calls += 1
        # 202 shape per the backend: job_id, status, report_url (the backend's own
        # link, built from its PUBLIC_SITE_URL — the web tier matching the API)
        return {
            "job_id": f"j-{self.calls}",
            "status": "MONITORING",
            "report_url": f"https://web.test/w/j-{self.calls}",
        }


def make_graph(reissue_budget: int = 0, webhook_url: str = "http://127.0.0.1:9098/hook"):
    stream = FakeStream()
    graph = build_graph(
        stream,  # type: ignore[arg-type]
        ScriptedLlm(),
        MemorySaver(),
        webhook_url=webhook_url,
        quote_source=lambda: "500",
    )
    return graph, stream


def run_to_pause(graph, objective="watch whales"):
    result = graph.invoke(
        {"objective": objective, "reissue_budget": 0, "reissues_used": 0},
        {"configurable": {"thread_id": "t-1"}},
    )
    return result


def test_graph_pauses_at_wait_for_webhook_without_observing():
    graph, stream = make_graph()
    result = run_to_pause(graph)
    # the invoke RETURNED at the pause — the graph is parked, nothing burned
    assert stream.calls == 1
    assert result["job_id"] == "j-1"
    assert result["quoted_ceiling"] == "500"
    assert result["report_url"] == "https://web.test/w/j-1"  # backend's own link, not recomputed
    interrupts = result.get("__interrupt__")
    assert interrupts, "expected the graph to park on wait_for_webhook"
    assert interrupts[0].value["state"] == "monitoring"
    assert result.get("narration", "") == ""  # observe never ran


def test_resume_with_delivery_notice_runs_observe_and_decide():
    graph, stream = make_graph()
    run_to_pause(graph)
    final = graph.invoke(Command(resume=DELIVERED), {"configurable": {"thread_id": "t-1"}})
    assert final["decision"] == "done"  # scripted: budget 0 → stop
    assert "settlement charged 100 atomic" in final["narration"]
    assert DISCLOSURE in final["narration"]  # 5.5a — always in transcripts
    assert stream.calls == 1  # no re-issue


def test_resume_with_timeout_notice_narrates_expiry():
    graph, _ = make_graph()
    run_to_pause(graph)
    final = graph.invoke(Command(resume=TIMEOUT), {"configurable": {"thread_id": "t-1"}})
    assert "expired without a match" in final["narration"]
    assert "charged 500 atomic" in final["narration"]


def test_zero_processed_timeout_says_nothing_was_charged():
    graph, _ = make_graph()
    run_to_pause(graph)
    # the sweep's zero-processed-blocks timeout: no tx, no amount (the stream was
    # stalled — the window never opened, deliberately unbilled)
    final = graph.invoke(Command(resume={"type": "intent.timeout", "intent_id": "j-1"}), {"configurable": {"thread_id": "t-1"}})
    assert "NOTHING was charged" in final["narration"]
    assert "never opened" in final["narration"]
    assert "USDC" in final["narration"]  # asset named, not the raw address


def test_watchdog_wake_is_called_out():
    graph, _ = make_graph()
    run_to_pause(graph)
    synthetic = {**TIMEOUT, "synthetic": True}
    final = graph.invoke(Command(resume=synthetic), {"configurable": {"thread_id": "t-1"}})
    assert "watchdog" in final["narration"]


def test_scripted_reissue_loop_negotiates_a_second_voucher():
    graph, stream = make_graph()
    # budget is part of the input state — rebuild with budget 1
    result = graph.invoke(
        {"objective": "keep listening", "reissue_budget": 1, "reissues_used": 0},
        {"configurable": {"thread_id": "t-2"}},
    )
    assert stream.calls == 1
    first = graph.invoke(Command(resume=DELIVERED), {"configurable": {"thread_id": "t-2"}})
    assert first["decision"] == "reissue"  # budget 1, used 0 → re-issue
    # the loop re-entered negotiate and parked on a NEW watch
    second = graph.invoke(Command(resume=TIMEOUT), {"configurable": {"thread_id": "t-2"}})
    assert stream.calls == 2  # second voucher — the per-block continuity path
    assert second["decision"] == "done"  # budget exhausted → stop
    assert second["reissues_used"] == 1


def test_webhook_url_reaches_the_stream_client():
    graph, stream = make_graph(webhook_url="http://127.0.0.1:9123/hook")
    run_to_pause(graph, objective="url check")
    assert stream.calls == 1
