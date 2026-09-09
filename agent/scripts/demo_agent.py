"""The agentic demo (5.6): LangGraph plan → x402 negotiate → PAUSE → webhook → resume.

One process hosts the graph + the webhook receiver. The graph parks on
wait_for_webhook (interrupt) — in LangGraph Studio (`langgraph dev`) you can literally
watch it sit in Monitoring state, zero compute, until the backend's webhook resumes
it. The decide node's re-issue loop re-enters negotiate for a fresh voucher — the
per-block model's continuity path, driven by the agent itself.

A watchdog resumes with a synthetic timeout if the webhook never arrives, so the demo
can't hang. Run with the backend live; moves real testnet money.

Usage:
  .venv/bin/python scripts/demo_agent.py                     # default objective
  .venv/bin/python scripts/demo_agent.py --reissues 0        # single watch, no loop
  AGENT_LLM=opencode .venv/bin/python scripts/demo_agent.py  # opencode as the brain
"""
from __future__ import annotations

import argparse
import json
import os
import threading
import time

from langgraph.types import Command

from agenttether.config import load_config
from agenttether.demo_graph import DemoStack
from agenttether.graph import factual_summary
from agenttether.webhook_server import WebhookServer


def report_link(state: dict) -> str:
    """The backend's own report_url wins — it builds the link from its PUBLIC_SITE_URL,
    so it always matches the web tier of the API the agent negotiated with. The env
    fallback only covers 202 bodies that predate the report_url field."""
    url = state.get("report_url")
    if url:
        return url
    site = os.environ.get("DEMO_SITE_URL") or os.environ.get("PUBLIC_SITE_URL") or "http://localhost:8888"
    return f"{site.rstrip('/')}/w/{state.get('job_id', '?')}"


def main() -> None:
    parser = argparse.ArgumentParser(description="AgentTether LangGraph demo agent")
    parser.add_argument(
        "--objective",
        default="Watch for any USDC transfer of at least 1 USDC on Ethereum mainnet and tell me what happens.",
    )
    parser.add_argument("--reissues", type=int, default=1, help="how many times the agent may buy another window")
    parser.add_argument(
        "--watch-json",
        default=None,
        help='override the default watch plan, e.g. \'{"watch_wallet": "0x…", "direction": "incoming", "ttl_seconds": 120}\'',
    )
    args = parser.parse_args()
    override = json.loads(args.watch_json) if args.watch_json else None

    cfg = load_config()
    server = WebhookServer(cfg)
    server.serve_background()
    time.sleep(0.5)
    print(f"agent payer: {cfg.wallet} · LLM: {cfg.llm_provider}")
    print(f"webhook receiver: {server.url()}")

    stack = DemoStack(webhook_url=server.url(), default_watch=override)
    thread = {"configurable": {"thread_id": f"agent-{int(time.time())}"}}

    done = threading.Event()
    resuming = threading.Lock()
    result: dict = {}
    watch_dog: dict = {"timer": None}

    def arm_watchdog(seconds: float) -> None:
        if watch_dog["timer"]:
            watch_dog["timer"].cancel()

        def fire() -> None:
            resume({"type": "intent.timeout", "synthetic": True, "intent_id": "watchdog"})

        timer = threading.Timer(seconds, fire)
        timer.daemon = True
        timer.start()
        watch_dog["timer"] = timer

    def resume(notice: dict) -> None:
        if done.is_set() or not resuming.acquire(blocking=False):
            return
        try:
            print(f"\n⟳ resume ← {notice.get('type')}{'' if not notice.get('synthetic') else ' (watchdog — the webhook never arrived)'}")
            final = stack.graph.invoke(Command(resume=notice), thread)
            if "__interrupt__" in final:
                # the decide node bought another window — parked on the NEW watch
                print("…agent bought another window, parked again (re-issue loop)")
                arm_watchdog(int(final["watch"]["ttl_seconds"]) + 180)
                return
            result["final"] = final
            done.set()
        finally:
            resuming.release()

    server.on_notice(resume)

    t0 = time.time()
    paused = stack.graph.invoke(
        {"objective": args.objective, "reissue_budget": args.reissues, "reissues_used": 0},
        thread,
    )
    job_id = paused.get("job_id", "?")
    w = paused.get("watch", {})
    min_atomic = int(str(w.get("min_amount_atomic", "0") or 0))
    usdc = f" (≈ {min_atomic / 1e6:,.0f} USDC)" if min_atomic and min_atomic % 1_000_000 == 0 else ""
    gate = f"transfers ≥ {min_atomic:,} atomic{usdc}" if min_atomic else "any transfer"
    if w.get("watch_wallet"):
        asset = f" on {w.get('target_contract')}" if w.get("target_contract") else " (any token)"
        print(f"plan: watch wallet {w.get('watch_wallet')} ({w.get('direction') or 'any'}){asset} for {gate}, ttl {w.get('ttl_seconds')}s — \"{w.get('query_intent')}\"")
    else:
        print(f"plan: watch {w.get('target_contract')} for {gate}, ttl {w.get('ttl_seconds')}s — \"{w.get('query_intent')}\"")
    print(f"negotiated: job {job_id} · quoted ceiling {paused.get('quoted_ceiling')} atomic")
    print(f"report page: {report_link(paused)}  ← watch this one live")
    print("⏸  PAUSED — agent asleep on wait_for_webhook (zero compute)…")
    arm_watchdog(int(paused.get("watch", {}).get("ttl_seconds", 60)) + 180)

    if not done.wait(timeout=600):
        print("FAIL: the agent never woke up")
        raise SystemExit(1)
    if watch_dog["timer"]:
        watch_dog["timer"].cancel()

    final = result["final"]
    notice = final.get("notice") or {}
    print(f"\nwoke after {time.time() - t0:.0f}s · decision: {final.get('decision')}")
    print(f"narration: {final.get('narration') or factual_summary(final)}")
    if notice.get("tx_hash"):
        print(f"settlement: https://sepolia.basescan.org/tx/{notice['tx_hash']}")
    print(f"report page: {report_link(final)}  ← shareable rendering of this watch (web tier)")
    print("\ndemo agent: PASS")


if __name__ == "__main__":
    main()
