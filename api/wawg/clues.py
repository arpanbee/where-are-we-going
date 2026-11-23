"""LLM clue generation via Meta's Muse API (OpenAI-compatible chat completions).
Shared by the API Lambda (partner rounds), the daily generator and
scripts/preview_clues.py."""

import json
import math
import os
import re
import socket
import time
import unicodedata
import urllib.error
import urllib.request

from .muse_key import get_muse_api_key

MUSE_BASE_URL = "https://api.meta.ai/v1"
DEFAULT_MODEL = "muse-spark-1.1"
CLUE_COUNT = 6
MAX_CLUE_LENGTH = 120  # each clue must be shorter than this
MAX_HINT_LENGTH = 240
ATTEMPT_TIMEOUT_S = 20.0
MAX_ATTEMPTS = 2  # first try + one retry
MIN_RETRY_BUDGET_S = 3.0
# Muse is a reasoning model: max_tokens covers hidden reasoning plus the answer.
# At 600 it spent the whole budget reasoning and returned null content.
MAX_TOKENS = 4000
DEFAULT_REASONING_EFFORT = "low"  # ~2x faster than default, same validation pass rate in testing


class ClueGenerationError(Exception):
    def __init__(self, message: str, problems=None):
        super().__init__(message)
        self.problems = problems or []


class MuseHttpError(Exception):
    def __init__(self, status: int):
        super().__init__(f"Muse API returned HTTP {status}")
        self.status = status
        # Auth and bad-request errors won't improve on retry.
        self.retryable = status in (408, 429) or status >= 500


class MuseTruncatedError(Exception):
    """The model hit max_tokens before writing an answer (usually all reasoning)."""


class MuseNetworkError(Exception):
    """Timeout or connection failure. Retryable."""


def build_prompt(name: str, country: str, hint: str | None = None) -> str:
    """Prompt from genClues() in the prototype, with a stricter JSON-only instruction."""
    note = str(hint or "").strip()[:MAX_HINT_LENGTH]
    prompt = (
        f"You write clues for a couples' travel guessing game. The answer is \"{name}\" ({country}). "
        "Write exactly 6 clues from vague to specific: clue 1 is about the vibe, weather, food or what to pack; "
        "each later clue narrows it down; clue 6 is nearly a giveaway. "
        "Never use the destination's name, the country's name, or words formed from them. "
        "Every clue must be factually accurate and under 16 words."
    )
    if note:
        prompt += (
            " The person setting the puzzle left a private hint about why this place matters to the couple. "
            f"If it fits, turn it into clue 3 or 4 without naming the place. Hint: {json.dumps(note, ensure_ascii=False)}"
        )
    return prompt + " Reply with only a JSON array of 6 strings. No prose, no markdown, no code fences."


def parse_clues(text):
    """Pulls a clue list out of the model's reply. Returns None if there isn't one."""
    s = str(text or "").strip()
    s = re.sub(r"^```(?:json)?\s*", "", s, flags=re.I)
    s = re.sub(r"\s*```$", "", s)

    def try_parse(t):
        try:
            v = json.loads(t)
        except ValueError:
            return None
        if isinstance(v, list):
            return v
        if isinstance(v, dict) and isinstance(v.get("clues"), list):
            return v["clues"]
        return None

    direct = try_parse(s)
    if direct is not None:
        return direct
    # Tolerate a sentence wrapped around the array.
    start, end = s.find("["), s.rfind("]")
    return try_parse(s[start : end + 1]) if start >= 0 and end > start else None


def _fold(s: str) -> str:
    """Lowercase and strip accents, so "CANCUN" matches "Cancún"."""
    return "".join(c for c in unicodedata.normalize("NFD", str(s)) if not unicodedata.combining(c)).casefold()


def forbidden_terms(name: str, country: str) -> list[str]:
    """Words clues 1-5 must not contain. "Zambia / Zimbabwe" yields both countries."""
    return [t.strip() for t in [name, *str(country).split("/")] if t.strip()]


def validate_clues(clues, name: str, country: str) -> list[str]:
    """Returns a list of problems, or [] when the clues are valid.
    Matching is case- and accent-insensitive and anchored at the start of a word,
    so "Peru" also catches "Peruvian" but "UK" doesn't trip on "duke"."""
    if not isinstance(clues, list):
        return ["reply was not a JSON array"]
    problems = []
    if len(clues) != CLUE_COUNT:
        problems.append(f"expected {CLUE_COUNT} clues, got {len(clues)}")
    # (?<![^\W_]) = not preceded by a letter or digit, i.e. the term starts a word.
    patterns = [(t, re.compile(r"(?<![^\W_])" + re.escape(_fold(t)))) for t in forbidden_terms(name, country)]
    for i, c in enumerate(clues[:CLUE_COUNT]):
        n = i + 1
        if not isinstance(c, str) or not c.strip():
            problems.append(f"clue {n} is empty or not a string")
            continue
        length = len(c.strip())
        if length >= MAX_CLUE_LENGTH:
            problems.append(f"clue {n} is {length} characters (must be under {MAX_CLUE_LENGTH})")
        if n <= 5:
            folded = _fold(c)
            for term, pattern in patterns:
                if pattern.search(folded):
                    problems.append(f'clue {n} names "{term}"')
    return problems


def _log_default(event: dict) -> None:
    print(json.dumps(event))


def generate_clues(
    name: str,
    country: str,
    hint: str | None = None,
    *,
    before_call=None,
    deadline: float = math.inf,
    model: str | None = None,
    reasoning_effort: str | None = None,
    api_key: str | None = None,
    post=None,
    log=_log_default,
) -> list[str]:
    """Generates 6 validated clues. Retries once on an invalid reply or a transient
    API error, then raises ClueGenerationError.

    before_call: runs before every HTTP attempt (spend cap). Exceptions it raises
        propagate unchanged.
    deadline: time.time() by which to give up. Attempt timeouts shrink to fit, and
        the retry is skipped if too little time remains.
    post: (url, headers, body_bytes, timeout) -> (status, body_bytes). For tests.
    log: receives attempt diagnostics (never the key or response bodies).
    """
    model = model or os.environ.get("MUSE_MODEL") or DEFAULT_MODEL
    effort = reasoning_effort or os.environ.get("MUSE_REASONING_EFFORT") or DEFAULT_REASONING_EFFORT
    post = post or _urllib_post
    prompt = build_prompt(name, country, hint)
    feedback = ""
    last_error = None

    for attempt in range(1, MAX_ATTEMPTS + 1):
        timeout = min(ATTEMPT_TIMEOUT_S, deadline - time.time() - 0.5)
        if attempt > 1 and timeout < MIN_RETRY_BUDGET_S:
            break
        if before_call:
            before_call()
        key = api_key or get_muse_api_key()
        try:
            content = _call_muse(post, key, model, effort, prompt + feedback, max(0.1, timeout))
            clues = parse_clues(content)
            problems = validate_clues(clues, name, country)
            if not problems:
                return [c.strip() for c in clues]
            last_error = ClueGenerationError("Muse reply failed validation", problems)
            log({"msg": "clue validation failed", "destination": name, "attempt": attempt, "problems": problems})
            feedback = f" Your previous reply had these problems, fix them: {'; '.join(problems)}."
        except (MuseHttpError, MuseTruncatedError, MuseNetworkError) as err:
            last_error = err
            log({"msg": "muse call failed", "destination": name, "attempt": attempt,
                 "error": type(err).__name__, "status": getattr(err, "status", None)})
            if isinstance(err, MuseHttpError) and not err.retryable:
                break

    if isinstance(last_error, ClueGenerationError):
        raise last_error
    raise ClueGenerationError(f"Couldn't generate clues for {name}") from last_error


def _call_muse(post, key, model, effort, prompt, timeout) -> str:
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": "You reply with JSON only."},
            {"role": "user", "content": prompt},
        ],
        "max_tokens": MAX_TOKENS,
    }
    if effort and effort != "none":
        body["reasoning_effort"] = effort
    status, raw = post(
        f"{MUSE_BASE_URL}/chat/completions",
        {"content-type": "application/json", "authorization": f"Bearer {key}"},
        json.dumps(body).encode(),
        timeout,
    )
    # Deliberately don't log response bodies: error payloads can echo request details.
    if status >= 400:
        raise MuseHttpError(status)
    data = json.loads(raw or b"{}")
    choice = (data.get("choices") or [{}])[0]
    content = (choice.get("message") or {}).get("content")
    if choice.get("finish_reason") == "length" and not content:
        raise MuseTruncatedError("Muse reply was cut off at max_tokens before any answer")
    return content or ""


def _urllib_post(url, headers, body, timeout):
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return res.status, res.read()
    except urllib.error.HTTPError as e:
        return e.code, b""
    except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError) as e:
        raise MuseNetworkError(type(e).__name__) from None
