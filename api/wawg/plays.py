from datetime import datetime, timezone

from .db import as_int, get_item, put_if, query_between
from .errors import HttpError
from .game import apply_guess, new_play
from .puzzles import get_puzzle


def _key(uid: str, date: str) -> dict:
    return {"PK": f"USER#{uid}", "SK": f"PLAY#{date}"}


def _from_item(it: dict) -> dict:
    return {
        "date": it["date"],
        "num": as_int(it.get("num")),
        "destId": it["destId"],
        "clues": list(it["clues"]),
        "guesses": list(it.get("guesses") or []),
        "done": bool(it.get("done")),
        "solved": bool(it.get("solved")),
        "points": as_int(it.get("points")),
    }


def get_play(uid: str, date: str):
    item = get_item(_key(uid, date))
    return _from_item(item) if item else None


def get_or_start_play(uid: str, date: str) -> dict:
    """The stored play, or a blank one for the date's current puzzle (not saved)."""
    return get_play(uid, date) or new_play(get_puzzle(date))


def guess(uid: str, date: str, dest_id: str) -> dict:
    """Judges and saves a guess. The guess count is an optimistic lock, so two tabs
    guessing at once can't both write; the loser gets a 409 and refreshes."""
    play = get_or_start_play(uid, date)
    nxt = apply_guess(play, dest_id)
    item = {**_key(uid, date), **nxt, "kind": "daily", "updatedAt": datetime.now(timezone.utc).isoformat()}
    if not put_if(item, "attribute_not_exists(PK) OR size(guesses) = :n", {":n": len(play["guesses"])}):
        raise HttpError(409, "That puzzle changed in another tab. Refresh and try again.")
    return nxt


def week_points(uid: str, start: str, end: str) -> int:
    """Sum of points for daily plays from `start` to `end` inclusive."""
    return sum(as_int(it.get("points")) for it in query_between(f"USER#{uid}", f"PLAY#{start}", f"PLAY#{end}"))
