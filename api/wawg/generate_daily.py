"""Daily clue generator, invoked by EventBridge Scheduler.
Ensures PUZZLE#<date> exists for today and the next 6 days (UTC). Each new puzzle
uses a destination not used in the previous 90 days and starts reviewed=false."""

import json
import os
from datetime import datetime, timezone

from . import muse_key
from .clues import DEFAULT_MODEL, generate_clues
from .dates import add_days, puzzle_number, utc_today
from .db import batch_get, muse_spend_guard, put_puzzle_if_absent, puzzle_key
from .errors import LimitError
from .pick import pick_destination

muse_key.prime()

DAYS_AHEAD = 7
REUSE_WINDOW_DAYS = 90


def handler(_event=None, _context=None):
    today = utc_today()
    targets = [add_days(today, i) for i in range(DAYS_AHEAD)]
    lookback = [add_days(today, -REUSE_WINDOW_DAYS + i) for i in range(REUSE_WINDOW_DAYS)]

    items = batch_get([puzzle_key(d) for d in lookback + targets])
    by_date = {it["PK"][len("PUZZLE#"):]: it for it in items}
    last_used: dict[str, str] = {}
    for d, it in by_date.items():
        if it["destId"] not in last_used or last_used[it["destId"]] < d:
            last_used[it["destId"]] = d

    created, skipped, failed = [], [], []
    for d in (t for t in targets if t not in by_date):
        dest = pick_destination(last_used, add_days(d, -REUSE_WINDOW_DAYS))
        last_used[dest["id"]] = d  # don't pick it again this run
        try:
            clues = generate_clues(dest["name"], dest["country"], before_call=muse_spend_guard)
            wrote = put_puzzle_if_absent({
                **puzzle_key(d),
                "date": d,
                "num": puzzle_number(d),
                "destId": dest["id"],
                "clues": clues,
                "reviewed": False,
                "source": "muse",
                "model": os.environ.get("MUSE_MODEL") or DEFAULT_MODEL,
                "createdAt": datetime.now(timezone.utc).isoformat(),
            })
            (created if wrote else skipped).append({"date": d, "destId": dest["id"]})
        except Exception as err:  # noqa: BLE001
            failed.append({"date": d, "destId": dest["id"], "error": type(err).__name__})
            if isinstance(err, LimitError):
                break  # spend cap hit; the rest would fail too

    summary = {"msg": "daily generation", "today": today, "created": created, "skipped": skipped, "failed": failed}
    print(json.dumps(summary))
    # Fail the invocation so it shows up in Lambda error metrics; the next run fills gaps.
    if failed:
        raise RuntimeError(f"Failed to generate {len(failed)} puzzle(s): {', '.join(f['date'] for f in failed)}")
    return summary
