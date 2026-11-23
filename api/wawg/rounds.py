"""Partner rounds: one partner picks a destination and 6 clues; the other guesses.

  COUPLE#<code> / ROUND#<id>  { from, to, destId, clues, created,
                                guesses, done, solved, points }

Only the recipient ("to") plays a round, so their play lives on the round item.
The recipient never receives destId until they've finished."""

import re
import secrets
import time

from .clues import _fold
from .dates import utc_today
from .db import as_int, get_item, put_if, query_prefix, take_quota, update_if
from .destinations import BY_ID
from .errors import HttpError, LimitError
from .game import apply_guess, play_view

MAX_CLUE_CHARS = 160  # hand-written clues get a little more room than generated ones
SENDS_PER_DAY = 20
LIST_LIMIT = 50
ROUND_ID_RE = re.compile(r"^[0-9]{13}[0-9a-f]{6}$")


def _key(code: str, round_id: str) -> dict:
    return {"PK": f"COUPLE#{code}", "SK": f"ROUND#{round_id}"}


def new_round_id() -> str:
    """Time-sortable, so a descending query lists newest first."""
    return f"{int(time.time() * 1000):013d}{secrets.token_hex(3)}"


def check_clues(clues, dest: dict) -> list[str]:
    """6 non-empty clues under MAX_CLUE_CHARS; clues 1-5 must not name the place.
    Same name matching as generated clues (case/accent-insensitive, word start)."""
    if not isinstance(clues, list) or len(clues) != 6 or not all(isinstance(c, str) and c.strip() for c in clues):
        return ["Fill in all 6 clues first."]
    if any(len(c.strip()) > MAX_CLUE_CHARS for c in clues):
        return [f"Keep each clue under {MAX_CLUE_CHARS} characters."]
    name = re.compile(r"(?<![^\W_])" + re.escape(_fold(dest["name"])))
    if any(name.search(_fold(c)) for c in clues[:5]):
        return ["One of the first five clues names the place. That gives it away."]
    return []


def send_round(code: str, sender: str, recipient: str, dest_id: str, clues) -> dict:
    dest = BY_ID.get(dest_id) if isinstance(dest_id, str) else None
    if not dest:
        raise HttpError(400, "Pick a destination from the list.")
    problems = check_clues(clues, dest)
    if problems:
        raise HttpError(400, problems[0])
    if not take_quota(f"LIMIT#sends#{code}#{utc_today()}", SENDS_PER_DAY):
        raise LimitError(f"You've sent {SENDS_PER_DAY} partner rounds today. Try again tomorrow.")
    round_id = new_round_id()
    item = {**_key(code, round_id), "id": round_id, "from": sender, "to": recipient, "destId": dest["id"],
            "clues": [c.strip() for c in clues], "created": int(time.time() * 1000),
            "guesses": [], "done": False, "solved": False, "points": 0}
    if not put_if(item, "attribute_not_exists(PK)"):
        raise RuntimeError("Round id collision")
    return {"id": round_id}


def _status(it: dict) -> str:
    if not it.get("guesses"):
        return "not-started"
    if not it.get("done"):
        return "guessing"
    return "solved" if it.get("solved") else "missed"


def list_rounds(code: str, uid: str) -> dict:
    """Rounds sent to me (no answers unless I've finished) and by me (with answers)."""
    inbox, sent = [], []
    for it in query_prefix(f"COUPLE#{code}", "ROUND#", newest_first=True, limit=LIST_LIMIT):
        summary = {"id": it["id"], "created": as_int(it.get("created")), "status": _status(it),
                   "guessCount": len(it.get("guesses") or []), "points": as_int(it.get("points"))}
        if it.get("to") == uid:
            inbox.append({**summary, "destId": it["destId"] if it.get("done") else None})
        elif it.get("from") == uid:
            sent.append({**summary, "destId": it["destId"]})
    return {"inbox": inbox, "sent": sent}


def _get_for_recipient(code: str, round_id: str, uid: str) -> dict:
    if not ROUND_ID_RE.match(round_id):
        raise HttpError(404, "That round doesn't exist.")
    it = get_item(_key(code, round_id))
    # Same answer whether it doesn't exist or isn't yours, so ids can't be probed.
    if not it or it.get("to") != uid:
        raise HttpError(404, "That round doesn't exist.")
    return it


def _as_play(it: dict) -> dict:
    return {"date": None, "num": None, "destId": it["destId"], "clues": list(it["clues"]),
            "guesses": list(it.get("guesses") or []), "done": bool(it.get("done")),
            "solved": bool(it.get("solved")), "points": as_int(it.get("points"))}


def round_view(code: str, round_id: str, uid: str) -> dict:
    it = _get_for_recipient(code, round_id, uid)
    return {**play_view(_as_play(it)), "id": round_id, "created": as_int(it.get("created"))}


def guess_round(code: str, round_id: str, uid: str, dest_id: str) -> dict:
    it = _get_for_recipient(code, round_id, uid)
    play = _as_play(it)
    nxt = apply_guess(play, dest_id)
    ok = update_if(
        _key(code, round_id),
        "SET #g = :g, #d = :d, #s = :s, #p = :p",
        "#to = :uid AND size(#g) = :n",
        {":g": nxt["guesses"], ":d": nxt["done"], ":s": nxt["solved"], ":p": nxt["points"],
         ":uid": uid, ":n": len(play["guesses"])},
        {"#to": "to", "#g": "guesses", "#d": "done", "#s": "solved", "#p": "points"},
    )
    if not ok:
        raise HttpError(409, "That round changed in another tab. Refresh and try again.")
    return {**play_view(nxt), "id": round_id, "created": as_int(it.get("created"))}


def unfinished_inbox_answers(code: str, uid: str) -> set[str]:
    """Destinations of rounds I'm still to finish: never reveal these elsewhere."""
    return {it["destId"] for it in query_prefix(f"COUPLE#{code}", "ROUND#", newest_first=True, limit=LIST_LIMIT)
            if it.get("to") == uid and not it.get("done")}
