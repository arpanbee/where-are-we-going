import json
import time

import pytest

from wawg.clues import ClueGenerationError, build_prompt, generate_clues, parse_clues, validate_clues
from wawg.destinations import DESTINATIONS
from wawg.errors import LimitError
from wawg.pick import pick_destination

GOOD = [
    "Built across seven hills, so pack shoes with grip.",
    "Locals queue for an egg-custard tart dusted with cinnamon.",
    "An old yellow tram is half commute, half ride.",
    "A mournful local music style is on UNESCO's heritage list.",
    "Its red suspension bridge looks a lot like San Francisco's.",
    "It's the westernmost capital in mainland Europe, Lisbon.",
]
LISBON = ("Lisbon", "Portugal")


def test_valid_clues_pass_and_clue_6_may_name_the_place():
    assert validate_clues(GOOD, *LISBON) == []


def test_rejects_wrong_count_empty_too_long():
    assert "expected 6" in validate_clues(GOOD[:5], *LISBON)[0]
    assert "clue 6 is empty" in validate_clues([*GOOD[:5], "  "], *LISBON)[0]
    long = list(GOOD)
    long[2] = "x" * 120
    assert "clue 3 is 120 characters" in validate_clues(long, *LISBON)[0]
    assert validate_clues(None, *LISBON) == ["reply was not a JSON array"]


def test_rejects_name_or_country_case_and_accent_insensitive():
    c = list(GOOD)
    c[0] = "Pack light for PORTUGAL in summer"
    c[4] = "Close to lisbon's airport"
    assert validate_clues(c, *LISBON) == ['clue 1 names "Portugal"', 'clue 5 names "Lisbon"']
    assert validate_clues(["Fly into CANCUN airport", *GOOD[1:]], "Cancún", "Mexico") == ['clue 1 names "Cancún"']
    # "Mexican" doesn't start with "mexico": allowed (the prompt asks the model to avoid it).
    assert validate_clues(["Mexican food", *GOOD[1:]], "Cancún", "Mexico") == []


def test_multi_country_and_word_start_matching():
    assert 'clue 1 names "Zimbabwe"' in validate_clues(["Bordering Zimbabwe", *GOOD[1:]], "Victoria Falls", "Zambia / Zimbabwe")
    assert validate_clues(["A duke once lived here", *GOOD[1:]], "Edinburgh", "UK") == []
    assert 'clue 1 names "Peru"' in validate_clues(["Peruvian food", *GOOD[1:]], "Machu Picchu", "Peru")
    assert 'clue 1 names "Peru"' in validate_clues(["Lima,peru vibes", *GOOD[1:]], "Machu Picchu", "Peru")


def test_parse_clues_handles_fences_wrappers_and_prose():
    assert parse_clues('```json\n["a","b"]\n```') == ["a", "b"]
    assert parse_clues('{"clues":["a"]}') == ["a"]
    assert parse_clues('Here you go: ["a","b"] enjoy') == ["a", "b"]
    assert parse_clues("no json") is None
    assert parse_clues(None) is None


def test_prompt_includes_hint_only_when_given():
    assert "Hint:" not in build_prompt(*LISBON)
    assert 'Hint: "first trip"' in build_prompt(*LISBON, "first trip")
    assert "JSON array of 6 strings" in build_prompt(*LISBON)


def reply(content, status=200, finish="stop"):
    return status, json.dumps({"choices": [{"finish_reason": finish, "message": {"content": json.dumps(content) if content is not None else None}}]}).encode()


class FakePost:
    def __init__(self, *replies):
        self.replies = list(replies)
        self.bodies = []
        self.timeouts = []

    def __call__(self, url, headers, body, timeout):
        assert url.endswith("/chat/completions")
        assert headers["authorization"] == "Bearer test-key"
        self.bodies.append(json.loads(body))
        self.timeouts.append(timeout)
        return self.replies.pop(0)


QUIET = {"api_key": "test-key", "log": lambda e: None}


def test_returns_trimmed_clues_on_first_valid_reply():
    post = FakePost(reply([f" {c} " for c in GOOD]))
    assert generate_clues(*LISBON, post=post, **QUIET) == GOOD
    assert len(post.bodies) == 1
    body = post.bodies[0]
    assert body["model"] == "muse-spark-1.1" and body["max_tokens"] == 4000 and body["reasoning_effort"] == "low"
    assert post.timeouts[0] == 20.0


def test_retries_once_with_feedback_counting_both_calls():
    bad = ["Lisbon is lovely", *GOOD[1:]]
    post = FakePost(reply(bad), reply(GOOD))
    guarded = []
    assert generate_clues(*LISBON, post=post, before_call=lambda: guarded.append(1), **QUIET) == GOOD
    assert len(guarded) == 2
    assert 'previous reply had these problems, fix them: clue 1 names "Lisbon"' in post.bodies[1]["messages"][1]["content"]


def test_raises_after_two_invalid_replies():
    post = FakePost(reply(["too few"]), reply(["too few"]))
    with pytest.raises(ClueGenerationError) as exc:
        generate_clues(*LISBON, post=post, **QUIET)
    assert "expected 6" in exc.value.problems[0]
    assert len(post.bodies) == 2


def test_no_retry_on_auth_error_but_retry_on_5xx():
    post = FakePost(reply(None, 401))
    with pytest.raises(ClueGenerationError):
        generate_clues(*LISBON, post=post, **QUIET)
    assert len(post.bodies) == 1
    post = FakePost(reply(None, 503), reply(GOOD))
    assert generate_clues(*LISBON, post=post, **QUIET) == GOOD


def test_retries_a_reply_truncated_by_max_tokens():
    events = []
    post = FakePost(reply(None, finish="length"), reply(GOOD))
    assert generate_clues(*LISBON, post=post, api_key="test-key", log=events.append) == GOOD
    assert events[0]["error"] == "MuseTruncatedError"


def test_spend_guard_errors_propagate_before_any_http_call():
    post = FakePost(reply(GOOD))

    def guard():
        raise LimitError("cap")

    with pytest.raises(LimitError):
        generate_clues(*LISBON, post=post, before_call=guard, **QUIET)
    assert post.bodies == []


def test_skips_retry_when_deadline_too_close():
    post = FakePost(reply(["x"]), reply(GOOD))
    with pytest.raises(ClueGenerationError):
        generate_clues(*LISBON, post=post, deadline=time.time() + 2, **QUIET)
    assert len(post.bodies) == 1


def test_pick_destination_avoids_recent_and_falls_back_to_least_recent():
    used = {"paris": "2026-11-01", "rome": "2026-01-01"}
    for _ in range(200):
        assert pick_destination(used, "2026-09-01")["id"] != "paris"
    all_recent = {d["id"]: "2026-11-10" for d in DESTINATIONS}
    all_recent["kyoto"] = "2026-10-01"
    assert pick_destination(all_recent, "2026-09-01")["id"] == "kyoto"
