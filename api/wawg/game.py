"""Pure game rules, ported from the prototype. No I/O, so they're unit-testable."""

import math

from .destinations import BY_ID

MAX_GUESSES = 6


class GuessError(Exception):
    """An invalid guess. The message is safe to show the player."""


def distance_km(a: dict, b: dict) -> float:
    """Haversine distance in km."""
    lat1, lat2 = math.radians(a["lat"]), math.radians(b["lat"])
    dlat = math.radians(b["lat"] - a["lat"])
    dlon = math.radians(b["lon"] - a["lon"])
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * 6371 * math.asin(math.sqrt(h))


def bearing_deg(a: dict, b: dict) -> float:
    """Initial bearing from a to b in degrees, 0 = north, clockwise."""
    lat1, lat2 = math.radians(a["lat"]), math.radians(b["lat"])
    dlon = math.radians(b["lon"] - a["lon"])
    y = math.sin(dlon) * math.cos(lat2)
    x = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlon)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def tier_for(km: float, correct: bool) -> str:
    """g = correct, y < 500 km, o < 2,000 km, r otherwise."""
    if correct:
        return "g"
    return "y" if km < 500 else "o" if km < 2000 else "r"


def _round(x: float) -> int:
    # JavaScript-style rounding (half up), so numbers match the prototype.
    return int(math.floor(x + 0.5))


def judge(guess_id: str, answer_id: str) -> dict:
    """Feedback for one guess against the answer."""
    g, t = BY_ID[guess_id], BY_ID[answer_id]
    correct = guess_id == answer_id
    km = 0.0 if correct else distance_km(g, t)
    return {
        "destId": guess_id,
        "km": _round(km),
        "bearing": None if correct else _round(bearing_deg(g, t)) % 360,
        "tier": tier_for(km, correct),
    }


def new_play(puzzle: dict) -> dict:
    """A fresh play that snapshots the puzzle, so later edits can't change the answer mid-game."""
    return {
        "date": puzzle["date"],
        "num": puzzle["num"],
        "destId": puzzle["destId"],
        "clues": list(puzzle["clues"]),
        "guesses": [],
        "done": False,
        "solved": False,
        "points": 0,
    }


def apply_guess(play: dict, guess_id: str) -> dict:
    """Returns the play with the guess applied, or raises GuessError."""
    if guess_id not in BY_ID:
        raise GuessError("Pick a destination from the list.")
    if play["done"]:
        raise GuessError("You've already finished this puzzle.")
    if guess_id in play["guesses"]:
        raise GuessError("You've already guessed that one.")
    guesses = [*play["guesses"], guess_id]
    solved = guess_id == play["destId"]
    done = solved or len(guesses) >= MAX_GUESSES
    return {**play, "guesses": guesses, "done": done, "solved": solved, "points": 7 - len(guesses) if solved else 0}


def play_view(play: dict) -> dict:
    """What the player may see: unlocked clues (1 + wrong guesses, all once done),
    feedback per guess, and the answer only once finished."""
    total = len(play["clues"])
    unlocked = total if play["done"] else min(total, len(play["guesses"]) + 1)
    return {
        "date": play["date"],
        "num": play["num"],
        "totalClues": total,
        "clues": play["clues"][:unlocked],
        "guesses": [judge(g, play["destId"]) for g in play["guesses"]],
        "done": play["done"],
        "solved": play["solved"],
        "points": play["points"],
        "answer": play["destId"] if play["done"] else None,
    }


def partner_view(partner_play, my_play_done: bool) -> dict:
    """The partner's play as the requester may see it. The result (colour tiers
    only, no destinations) is included only once the requester has finished."""
    if not partner_play or not partner_play["guesses"]:
        return {"status": "not-started"}
    if not partner_play["done"]:
        return {"status": "guessing"}
    if not my_play_done:
        return {"status": "finished"}
    return {
        "status": "finished",
        "result": {
            "tiers": [judge(g, partner_play["destId"])["tier"] for g in partner_play["guesses"]],
            "solved": partner_play["solved"],
            "points": partner_play["points"],
        },
    }
