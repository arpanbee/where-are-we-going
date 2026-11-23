import random

from .destinations import DESTINATIONS


def pick_destination(last_used: dict, cutoff: str, rng=random) -> dict:
    """Random destination not used on or after `cutoff`. If every destination was
    used inside the window, falls back to the least recently used one."""
    fresh = [d for d in DESTINATIONS if not (last_used.get(d["id"], "") >= cutoff)]
    if fresh:
        return rng.choice(fresh)
    return min(DESTINATIONS, key=lambda d: last_used.get(d["id"], ""))
