"""Bucket-list votes, stored per player (USER#<uid> / VOTE#<destId> {v: 0|1}), so
they work solo and survive leaving a couple. "Trips we both want" is the
intersection of both partners' yes votes."""

from .db import as_int, query_prefix, table
from .destinations import BY_ID
from .errors import HttpError


def cast_vote(uid: str, dest_id, v) -> None:
    if not isinstance(dest_id, str) or dest_id not in BY_ID:
        raise HttpError(400, "Pick a destination from the list.")
    if v not in (0, 1) or isinstance(v, bool):
        raise HttpError(400, "A vote is 1 (we should go) or 0 (not for me).")
    table.put_item(Item={"PK": f"USER#{uid}", "SK": f"VOTE#{dest_id}", "destId": dest_id, "v": v})


def votes_of(uid: str) -> dict:
    return {it["destId"]: as_int(it.get("v")) for it in query_prefix(f"USER#{uid}", "VOTE#")
            if it.get("destId") in BY_ID}


def bucket_list(uid: str, partner_id, hidden: set) -> dict:
    """My votes, places we both want, places only I want, and places my partner
    wants that I haven't voted on. `hidden` holds answers to puzzles I haven't
    finished, which are never shown from my partner's side."""
    mine = votes_of(uid)
    theirs = votes_of(partner_id) if partner_id else {}
    both = sorted(d for d, v in mine.items() if v == 1 and theirs.get(d) == 1)
    only_me = sorted(d for d, v in mine.items() if v == 1 and d not in both)
    partner_wants = sorted(d for d, v in theirs.items() if v == 1 and d not in mine and d not in hidden)
    return {"mine": mine, "both": both, "onlyMe": only_me, "partnerWants": partner_wants}
