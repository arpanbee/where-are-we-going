"""Dates are "YYYY-MM-DD" strings, treated as calendar days (no time zone math)."""

import re
from datetime import date, datetime, timedelta, timezone

FIRST_PUZZLE_DATE = "2026-11-22"  # puzzle #1, same as the prototype's START
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _parse(ymd: str) -> date:
    return date.fromisoformat(ymd)


def utc_today() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def add_days(ymd: str, n: int) -> str:
    return (_parse(ymd) + timedelta(days=n)).isoformat()


def days_between(a: str, b: str) -> int:
    return (_parse(b) - _parse(a)).days


def is_valid_date(s) -> bool:
    if not isinstance(s, str) or not _DATE_RE.match(s):
        return False
    try:
        _parse(s)
    except ValueError:
        return False
    return True


def puzzle_number(ymd: str) -> int:
    """Number shown to players (#1 on FIRST_PUZZLE_DATE)."""
    return max(0, days_between(FIRST_PUZZLE_DATE, ymd)) + 1


def monday_of(ymd: str) -> str:
    """Monday on or before the given date (weeks run Monday to Sunday)."""
    d = _parse(ymd)
    return (d - timedelta(days=d.weekday())).isoformat()
