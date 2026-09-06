"""5.2 live spike: the Python client's full loop against a running backend.

Beat A (stream, fires): min 1000 USDC — mainnet USDC matches ≥$1k in nearly every
  block → settlement.confirmed webhook with event data + pro-rata settle tx.
Beat B (stream, idle): min 1B USDC — never fires → intent.timeout webhook with the
  full block-budget settle tx.
Beat C (oneshot): flat-fee lookup → 200 + transfers.

Run with the backend live (`launchctl` daemon or npm start). Moves real testnet money.
"""
from __future__ import annotations

import sys
import time

from agenttether.config import load_config
from agenttether.oneshot_client import OneshotClient
from agenttether.stream_client import StreamClient
from agenttether.webhook_server import WebhookServer
from agenttether.x402_session import x402_session

USDC_MAINNET = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
MIN_1000_USDC = "1000000000"
MIN_1B_USDC = "1000000000000000000"

cfg = load_config()
session, quote = x402_session(cfg)
print(f"agent payer: {cfg.wallet}")

server = WebhookServer(cfg)
server.serve_background()
time.sleep(0.5)
print(f"webhook receiver: {server.url()}")

stream = StreamClient(session, cfg.server_url)


def stream_beat(min_amount: str, expect_type: str, label: str) -> None:
    t0 = time.time()
    job = stream.create_intent(
        target_contract=USDC_MAINNET,
        min_amount_atomic=min_amount,
        ttl_seconds=cfg.max_ttl_s,
        webhook_url=server.url(),
        query_intent=f"5.2 spike: {label}",
    )
    print(f"[{label}] stream → 202 in {time.time() - t0:.1f}s · job {job['job_id'][:8]} · status {job['status']}")
    print(f"[{label}] agent asleep — waiting for the backend webhook (up to 4 min)…")
    t1 = time.time()
    notices = server.notices(job["job_id"], wait=True, timeout=240)
    if not notices:
        print(f"FAIL [{label}]: no webhook arrived")
        sys.exit(1)
    notice = notices[-1]
    events = notice.get("events") or []
    print(
        f"[{label}] webhook ← {notice.get('type')} in {time.time() - t1:.0f}s · "
        f"tx {notice.get('tx_hash')} · charged {notice.get('amount_charged_atomic')} atomic · "
        f"{notice.get('events_matched')} events"
    )
    for e in events[:2]:
        print(f"    · block {e['block']} {e['amount_atomic']} atomic (bare-hex webhook form: {e['tx_hash'][:16]}…)")
    assert notice.get("type") == expect_type, (label, notice.get("type"), expect_type)
    assert notice.get("tx_hash"), f"[{label}] expected a settle tx"
    print(f"[{label}] basescan: https://sepolia.basescan.org/tx/{notice['tx_hash']}")


stream_beat(MIN_1000_USDC, "settlement.confirmed", "beat A: fires, pro-rata")
stream_beat(MIN_1B_USDC, "intent.timeout", "beat B: idle, full budget")

# ---- beat C: oneshot flat-fee lookup --------------------------------------------
oneshot = OneshotClient(session, cfg.server_url)
t2 = time.time()
out = oneshot.lookup(USDC_MAINNET, min_amount_atomic="1000000", lookback_blocks=300, limit=5)
print(f"[beat C: oneshot] → 200 in {time.time() - t2:.1f}s · window {out['window']['fromBlock']}–{out['window']['toBlock']} · {len(out['transfers'])} transfers")
for t in out["transfers"][:3]:
    print(f"    · block {t['block_num']} {t['amount_atomic']} atomic {t['from'][:10]}→{t['to'][:10]}")

print("\n5.2 spike: PASS — Python SDK upto parity confirmed end-to-end (both stream beats + oneshot)")
