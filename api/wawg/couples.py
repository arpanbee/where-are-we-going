"""Couples: a 6-character code shared by at most two members.
  COUPLE#<code> / META    { members: [uid, uid?], created }
  USER#<uid>    / COUPLE  { code }
Both items change together in a transaction so they can't disagree."""

import re
import secrets
import time

from .db import TransactionConflict, get_item, transact
from .errors import HttpError

ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O or 1/I, same as the prototype
CODE_RE = re.compile(r"^[A-Z0-9]{6}$")


def _couple_key(code: str) -> dict:
    return {"PK": f"COUPLE#{code}", "SK": "META"}


def _pointer_key(uid: str) -> dict:
    return {"PK": f"USER#{uid}", "SK": "COUPLE"}


def new_code() -> str:
    return "".join(secrets.choice(ALPHABET) for _ in range(6))


def _already_paired() -> HttpError:
    return HttpError(409, "You're already paired. Leave your current pairing first.")


def get_couple(code: str):
    c = get_item(_couple_key(code))
    return {"code": code, "members": list(c.get("members") or [])} if c else None


def couple_of(uid: str):
    """The requester's couple as {code, members}, or None."""
    ptr = get_item(_pointer_key(uid))
    if not ptr or not ptr.get("code"):
        return None
    c = get_couple(ptr["code"])
    return c if c and uid in c["members"] else None


def create_couple(uid: str) -> dict:
    for _ in range(5):
        code = new_code()
        try:
            transact([
                {"Put": {"Item": {**_couple_key(code), "members": [uid], "created": int(time.time() * 1000)},
                         "ConditionExpression": "attribute_not_exists(PK)"}},
                {"Put": {"Item": {**_pointer_key(uid), "code": code},
                         "ConditionExpression": "attribute_not_exists(PK)"}},
            ])
            return {"code": code, "members": [uid]}
        except TransactionConflict as err:
            if err.index == 0:
                continue  # code taken, try another
            raise _already_paired() from None
    raise RuntimeError("Couldn't find a free couple code")


def join_couple(uid: str, code: str) -> dict:
    c = get_couple(code)
    if not c:
        raise HttpError(404, "No couple found with that code.")
    if uid in c["members"]:
        return c  # already in: joining again is a no-op
    if len(c["members"]) >= 2:
        raise HttpError(409, "That code already has two people.")
    try:
        transact([
            {"Update": {"Key": _couple_key(code),
                        "UpdateExpression": "SET members = list_append(members, :me)",
                        "ConditionExpression": "size(members) < :two AND NOT contains(members, :uid)",
                        "ExpressionAttributeValues": {":me": [uid], ":two": 2, ":uid": uid}}},
            {"Put": {"Item": {**_pointer_key(uid), "code": code},
                     "ConditionExpression": "attribute_not_exists(PK)"}},
        ])
    except TransactionConflict as err:
        if err.index == 0:
            raise HttpError(409, "That code already has two people.") from None
        raise _already_paired() from None
    return {"code": code, "members": [*c["members"], uid]}


def leave_couple(uid: str) -> None:
    """Leaves the current couple. The code stays valid so someone can join again."""
    ptr = get_item(_pointer_key(uid))
    if not ptr or not ptr.get("code"):
        return
    c = get_couple(ptr["code"])
    idx = c["members"].index(uid) if c and uid in c["members"] else -1
    items = [{"Delete": {"Key": _pointer_key(uid)}}]
    if idx >= 0:
        items.append({"Update": {"Key": _couple_key(ptr["code"]),
                                 "UpdateExpression": f"REMOVE members[{idx}]",
                                 "ConditionExpression": f"members[{idx}] = :uid",
                                 "ExpressionAttributeValues": {":uid": uid}}})
    try:
        transact(items)
    except TransactionConflict:
        raise HttpError(409, "Your pairing changed just now. Refresh and try again.") from None
