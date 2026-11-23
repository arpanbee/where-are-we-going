"""HTTP API (payload v2) entry point. CloudFront routes /api/* here.

  GET  /api/today?date=YYYY-MM-DD        puzzle + my play (clues unlocked so far)
  POST /api/today/guess {date, destId}   judge a guess server-side
  GET  /api/state?date=YYYY-MM-DD        couple, partner status, week scores
  POST /api/couples                      create a couple code
  POST /api/couples/{code}/join
  POST /api/couples/leave
  POST /api/couples/{code}/rounds {destId, hint?}   draft partner-round clues

Identity is the X-Device-Token header (see httputil.py). "Today" is the player's
local date, accepted within a day of UTC so no time zone is locked out but future
puzzles stay hidden.
"""

import json
import re
import time
import urllib.parse

from . import muse_key
from .clues import MAX_HINT_LENGTH, ClueGenerationError, generate_clues
from .couples import CODE_RE, couple_of, create_couple, get_couple, join_couple, leave_couple
from .dates import add_days, is_valid_date, monday_of, utc_today
from .db import ROUND_DRAFTS_PER_DAY, muse_spend_guard, take_quota
from .destinations import BY_ID
from .errors import HttpError, LimitError
from .game import GuessError, new_play, partner_view, play_view
from .httputil import parse_body, require_uid, uid_from
from .plays import get_or_start_play, get_play, guess, week_points
from .puzzles import get_puzzle

muse_key.prime()  # fetch the key during cold start; cached for the container's life

RESPONSE_MARGIN_S = 1.5  # keep under API Gateway's 30 s limit (Lambda timeout is 29 s)


def _json(status: int, body) -> dict:
    return {
        "statusCode": status,
        "headers": {"content-type": "application/json", "cache-control": "no-store"},
        "body": json.dumps(body, ensure_ascii=False),
    }


def _play_date(value) -> str:
    today = utc_today()
    d = value if value is not None else today
    if not is_valid_date(d) or d < add_days(today, -1) or d > add_days(today, 1):
        raise HttpError(400, "That date isn't available.")
    return d


def _couple_code(raw: str) -> str:
    code = urllib.parse.unquote(raw).strip().upper()
    if not CODE_RE.match(code):
        raise HttpError(404, "No couple found with that code.")
    return code


def _qs(event: dict) -> dict:
    return event.get("queryStringParameters") or {}


# --- Puzzle -------------------------------------------------------------------------

def get_today(event, _ctx):
    d = _play_date(_qs(event).get("date"))
    uid = uid_from(event)  # optional: without a token you just see clue 1
    return play_view(get_or_start_play(uid, d) if uid else new_play(get_puzzle(d)))


def post_guess(event, _ctx):
    uid = require_uid(event)
    body = parse_body(event)
    d = _play_date(body.get("date"))
    if not isinstance(body.get("destId"), str):
        raise HttpError(400, "Pick a destination from the list.")
    return play_view(guess(uid, d, body["destId"]))


# --- Couple state (polled by the client) ------------------------------------------

def get_state(event, _ctx):
    uid = require_uid(event)
    d = _play_date(_qs(event).get("date"))
    week_start = monday_of(d)
    couple = couple_of(uid)
    mine = get_play(uid, d)
    partner_id = next((m for m in couple["members"] if m != uid), None) if couple else None
    partner = None
    if partner_id:
        partner = {**partner_view(get_play(partner_id, d), bool(mine and mine["done"])),
                   "week": week_points(partner_id, week_start, d)}
    return {
        "date": d,
        "weekStart": week_start,
        "couple": {"code": couple["code"], "paired": bool(partner_id)} if couple else None,
        "me": {"week": week_points(uid, week_start, d)},
        "partner": partner,
    }


# --- Couples ------------------------------------------------------------------------

def post_couple(event, _ctx):
    c = create_couple(require_uid(event))
    return {"code": c["code"], "paired": False}


def post_join(event, _ctx, raw_code):
    c = join_couple(require_uid(event), _couple_code(raw_code))
    return {"code": c["code"], "paired": len(c["members"]) == 2}


def post_leave(event, _ctx):
    leave_couple(require_uid(event))
    return {"ok": True}


# --- Partner rounds -----------------------------------------------------------------

def draft_round(event, ctx, raw_code):
    """Draft 6 clues for a partner round. Nothing is stored until it's sent (step 4)."""
    uid = require_uid(event)
    code = _couple_code(raw_code)
    couple = get_couple(code)
    # Same response for "no such couple" and "not a member", so codes can't be probed.
    if not couple or uid not in couple["members"]:
        raise HttpError(404, "No couple found with that code.")

    body = parse_body(event)
    dest = BY_ID.get(body.get("destId")) if isinstance(body.get("destId"), str) else None
    if not dest:
        raise HttpError(400, "Pick a destination from the list.")
    hint = body.get("hint")
    if hint is not None and not isinstance(hint, str):
        raise HttpError(400, "The hint must be text.")
    hint = (hint or "").strip()[:MAX_HINT_LENGTH]

    if not take_quota(f"LIMIT#rounds#{code}#{utc_today()}", ROUND_DRAFTS_PER_DAY):
        raise LimitError(
            f"You've drafted {ROUND_DRAFTS_PER_DAY} partner rounds today. "
            "Try again tomorrow, or write the clues yourself."
        )
    deadline = time.time() + ctx.get_remaining_time_in_millis() / 1000 - RESPONSE_MARGIN_S
    clues = generate_clues(dest["name"], dest["country"], hint, before_call=muse_spend_guard, deadline=deadline)
    return {"draft": {"destId": dest["id"], "clues": clues}}


ROUTES = [
    ("GET", re.compile(r"^/api/today$"), get_today),
    ("POST", re.compile(r"^/api/today/guess$"), post_guess),
    ("GET", re.compile(r"^/api/state$"), get_state),
    ("POST", re.compile(r"^/api/couples$"), post_couple),
    ("POST", re.compile(r"^/api/couples/leave$"), post_leave),
    ("POST", re.compile(r"^/api/couples/([^/]+)/join$"), post_join),
    ("POST", re.compile(r"^/api/couples/([^/]+)/rounds$"), draft_round),
]


def handler(event, context):
    method = ((event.get("requestContext") or {}).get("http") or {}).get("method")
    path = event.get("rawPath") or ""
    try:
        for m, pattern, fn in ROUTES:
            match = pattern.match(path) if method == m else None
            if match:
                return _json(200, fn(event, context, *match.groups()))
        return _json(404, {"error": "Not found."})
    except HttpError as err:
        return _json(err.status, {"error": err.message})
    except GuessError as err:
        return _json(400, {"error": str(err)})
    except ClueGenerationError as err:
        print(json.dumps({"msg": "clue generation failed", "problems": err.problems,
                          "cause": type(err.__cause__).__name__ if err.__cause__ else None}))
        return _json(502, {"error": "Couldn't write clues just now. You can write them yourself."})
    except Exception as err:  # noqa: BLE001
        print(json.dumps({"msg": "unhandled error", "path": path, "error": type(err).__name__, "message": str(err)}))
        return _json(500, {"error": "Something went wrong. Try again in a moment."})
