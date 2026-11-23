from .dates import FIRST_PUZZLE_DATE, days_between, puzzle_number
from .db import get_item, puzzle_key
from .destinations import FALLBACK_PUZZLES


def get_puzzle(date: str) -> dict:
    """The PUZZLE#<date> item whether or not it's reviewed, otherwise the prototype's
    hand-written puzzle for that day (same rotation as the prototype)."""
    item = get_item(puzzle_key(date))
    base = {"date": date, "num": puzzle_number(date)}
    if item and isinstance(item.get("clues"), list) and len(item["clues"]) == 6:
        return {**base, "destId": item["destId"], "clues": list(item["clues"]),
                "source": "generated", "reviewed": bool(item.get("reviewed"))}
    day = max(0, days_between(FIRST_PUZZLE_DATE, date))
    fb = FALLBACK_PUZZLES[day % len(FALLBACK_PUZZLES)]
    return {**base, "destId": fb["destId"], "clues": list(fb["clues"]), "source": "fallback", "reviewed": True}
