#!/usr/bin/env python3
"""Capture what agent-dispatch itself says about a synthetic home.

The built-in adapter reads agent-dispatch's state files directly, so it
repeats that tool's file layout and its spend rule. This script builds a home
on disk, asks `agent-dispatch board --json` (the tool's own read-only
snapshot) about it, and writes the home and the answer to
tests/fixtures/conformance.generated.ts. tests/conformance.test.ts then reads
the same home through the adapter and fails on any difference in what the
board would draw.

Run it again whenever agent-dispatch changes its state files or its spend
rule, then run the tests:

    python3 scripts/conformance.py /path/to/agent-dispatch
    claude plugin test .

Every value in the fixture is synthetic. Standard library only.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

MINUTE = 60
HOUR = 60 * MINUTE
DAY = 24 * HOUR


def iso(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# One order of every kind the board sorts differently.
ORDERS = [
    dict(id="20260105-090000-queued", state="queued", worker="lane-a",
         project="/srv/work/atlas-api", queued_ago=4 * MINUTE),
    dict(id="20260105-090100-running", state="running", worker="lane-a",
         project="/srv/work/atlas-api", started_ago=12 * MINUTE, active_ago=20,
         attempts=[("lane-a", 12 * MINUTE, 0.5)]),
    dict(id="20260105-090200-reviewing", state="reviewing", worker="lane-a",
         current_worker="lane-b", slot_worker="lane-b",
         project="/srv/work/billing-ui", attempt=2, started_ago=27 * MINUTE, active_ago=90,
         attempts=[("lane-a", 70 * MINUTE, 0.25), ("lane-b", 27 * MINUTE, 1.5)]),
    dict(id="20260105-090300-needs-review", state="needs_review", worker="lane-b",
         project="/srv/work/docs-site", started_ago=3 * HOUR, finished_ago=2 * HOUR,
         attempts=[("lane-b", 3 * HOUR, 0.75)]),
    dict(id="20260105-090400-check-failed", state="check_failed", worker="lane-a",
         project="/srv/work/atlas-api", attempt=3, started_ago=3 * DAY,
         finished_ago=3 * DAY - HOUR, attempts=[("lane-a", 3 * DAY, None)]),
    dict(id="20260105-090500-no-changes", state="no_changes", worker="lane-c",
         project="/srv/work/docs-site", started_ago=30 * DAY, finished_ago=30 * DAY - HOUR),
    dict(id="20260105-090600-accepted-today", state="accepted", worker="lane-a",
         project="/srv/work/atlas-api", started_ago=2 * HOUR, finished_ago=HOUR,
         attempts=[("lane-a", 2 * HOUR, 1.25)]),
    dict(id="20260105-090700-rejected-old", state="rejected", worker="lane-b",
         project="/srv/work/billing-ui", started_ago=40 * DAY, finished_ago=40 * DAY - HOUR,
         attempts=[("lane-b", 40 * DAY, 9)]),
]

CONFIG = {
    "max_parallel": 4,
    "workers": {
        "lane-a": {"budget_usd_month": 10},
        "lane-b": {"budget_usd_month": 5},
        "lane-c": {"budget_usd_month": 0},
    },
}


def build(root: Path, now: float) -> None:
    (root / "orders").mkdir(parents=True)
    (root / "config.json").write_text(json.dumps(CONFIG))
    for spec in ORDERS:
        d = root / "orders" / spec["id"]
        d.mkdir()
        first = spec.get("queued_ago", spec.get("started_ago", 0))
        (d / "meta.json").write_text(json.dumps({
            "id": spec["id"], "project": spec["project"], "worker": spec["worker"],
            "title": "Synthetic order", "created_at": iso(now - first),
        }))
        state = {
            "state": spec["state"],
            "attempt": spec.get("attempt", 1),
            "attempts": [
                {"worker": w, "started_at": iso(now - ago), "cost": cost}
                for w, ago, cost in spec.get("attempts", [])
            ],
        }
        for key, field in (("queued_ago", "queued_at"), ("started_ago", "started_at"),
                           ("finished_ago", "finished_at")):
            if key in spec:
                state[field] = iso(now - spec[key])
        for key in ("current_worker", "slot_worker"):
            if key in spec:
                state[key] = spec[key]
        (d / "state.json").write_text(json.dumps(state))
        # state.json counts as activity too, so its time is set as well.
        touched = now - spec.get("active_ago", spec.get("finished_ago", spec.get("queued_ago", 0)))
        os.utime(d / "state.json", (touched, touched))
        if "active_ago" in spec:
            events = d / f"events-{spec.get('attempt', 1)}.jsonl"
            events.write_text("{}\n")
            os.utime(events, (touched, touched))
    # A half-written order: both sides must leave it out.
    broken = root / "orders" / "20260105-090800-half-written"
    broken.mkdir()
    (broken / "meta.json").write_text(json.dumps(
        {"id": "20260105-090800-half-written", "project": "/srv/work/atlas-api", "worker": "lane-a"}))
    (broken / "state.json").write_text('{"state": "runn')


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__.strip().splitlines()[0])
        print("usage: python3 scripts/conformance.py /path/to/agent-dispatch", file=sys.stderr)
        return 2
    tool = sys.argv[1]
    here = Path(__file__).resolve().parent.parent
    # A whole second, so that every time the tool prints survives the round trip.
    now = float(int(time.time()))
    home = Path(tempfile.mkdtemp(prefix="dispatch-board-conformance-"))
    root = home / ".agent-dispatch"
    try:
        build(root, now)
        env = {**os.environ, "HOME": str(home), "AGENT_DISPATCH_HOME": str(root)}
        ran = subprocess.run([sys.executable, tool, "board", "--json"], env=env,
                             capture_output=True, text=True, timeout=30)
        if ran.returncode != 0:
            print(f"agent-dispatch board --json exited {ran.returncode}: {ran.stderr.strip()[:300]}",
                  file=sys.stderr)
            return 1
        board = json.loads(ran.stdout)
        version = subprocess.run([sys.executable, tool, "--version"], env=env,
                                 capture_output=True, text=True, timeout=30).stdout.strip()
        files, mtimes = {}, {}
        for path in sorted(p for p in root.rglob("*") if p.is_file()):
            rel = path.relative_to(root).as_posix()
            files[rel] = path.read_text()
            mtimes[rel] = int(path.stat().st_mtime * 1000)
    finally:
        shutil.rmtree(home, ignore_errors=True)

    captured = {"now": int(now * 1000), "tool": version, "files": files, "mtimes": mtimes, "board": board}
    out = here / "tests" / "fixtures" / "conformance.generated.ts"
    out.write_text(
        "// Generated by scripts/conformance.py. Do not edit by hand: run the script again.\n"
        "// A synthetic agent-dispatch home, and what `agent-dispatch board --json` printed for it.\n\n"
        "export const CAPTURED = "
        + json.dumps(captured, indent=2, ensure_ascii=True)
        + " as const\n"
    )
    open_orders = [o for o in board.get("orders", []) if o.get("state") not in
                   ("accepted", "rejected", "cancelled", "done")]
    print(f"captured {len(files)} files, {len(open_orders)} open orders, "
          f"skipped {board.get('skipped')} -> {out.relative_to(here)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
