import pytest

from wawg.dates import add_days, is_valid_date, monday_of, puzzle_number
from wawg.game import GuessError, apply_guess, judge, new_play, partner_view, play_view

CLUES = ["c1", "c2", "c3", "c4", "c5", "c6"]


def start():
    return new_play({"date": "2026-11-23", "num": 2, "destId": "lisbon", "clues": CLUES})


def play_through(p, guesses):
    for g in guesses:
        p = apply_guess(p, g)
    return p


def test_judge_distance_bearing_and_tiers():
    assert judge("lisbon", "lisbon") == {"destId": "lisbon", "km": 0, "bearing": None, "tier": "g"}
    porto = judge("porto", "lisbon")  # ~274 km, roughly south
    assert porto["tier"] == "y" and 250 < porto["km"] < 300 and 150 < porto["bearing"] < 210
    assert judge("paris", "lisbon")["tier"] == "o"  # ~1,450 km
    assert judge("tokyo", "lisbon")["tier"] == "r"


def test_judge_matches_node_implementation_values():
    # Values produced by the previous Node version, to prove the port is exact.
    assert judge("paris", "lisbon") == {"destId": "paris", "km": 1453, "bearing": 223, "tier": "o"}
    assert judge("tokyo", "lisbon") == {"destId": "tokyo", "km": 11144, "bearing": 336, "tier": "r"}


def test_clue_unlocking_and_answer_reveal():
    p = start()
    assert play_view(p)["clues"] == ["c1"]
    p = apply_guess(p, "paris")
    assert play_view(p)["clues"] == ["c1", "c2"]
    assert play_view(p)["answer"] is None
    p = apply_guess(p, "lisbon")
    assert len(play_view(p)["clues"]) == 6 and play_view(p)["answer"] == "lisbon"


def test_scoring():
    p = apply_guess(start(), "lisbon")
    assert (p["done"], p["solved"], p["points"]) == (True, True, 6)
    five_wrong = ["paris", "rome", "tokyo", "porto", "madrid"]
    p = play_through(start(), five_wrong)
    assert not p["done"]
    p = apply_guess(p, "seville")
    assert (p["done"], p["solved"], p["points"], len(p["guesses"])) == (True, False, 0, 6)
    assert apply_guess(play_through(start(), five_wrong), "lisbon")["points"] == 1


def test_rejects_unknown_repeated_and_post_finish_guesses():
    with pytest.raises(GuessError):
        apply_guess(start(), "atlantis")
    with pytest.raises(GuessError, match="already guessed"):
        apply_guess(apply_guess(start(), "paris"), "paris")
    with pytest.raises(GuessError, match="already finished"):
        apply_guess(apply_guess(start(), "lisbon"), "paris")


def test_partner_result_hidden_until_my_play_done():
    assert partner_view(None, False) == {"status": "not-started"}
    assert partner_view(start(), True) == {"status": "not-started"}
    guessing = apply_guess(start(), "paris")
    assert partner_view(guessing, True) == {"status": "guessing"}
    finished = apply_guess(guessing, "lisbon")
    assert partner_view(finished, False) == {"status": "finished"}
    assert partner_view(finished, True) == {"status": "finished", "result": {"tiers": ["o", "g"], "solved": True, "points": 5}}


def test_dates():
    assert monday_of("2026-11-23") == "2026-11-23"  # Monday
    assert monday_of("2026-11-29") == "2026-11-23"  # Sunday
    assert monday_of("2026-11-22") == "2026-11-16"
    assert monday_of("2027-01-01") == "2026-12-28"
    assert add_days("2026-12-31", 1) == "2027-01-01"
    assert puzzle_number("2026-11-22") == 1 and puzzle_number("2026-11-23") == 2 and puzzle_number("2026-01-01") == 1
    assert is_valid_date("2026-02-28") and not is_valid_date("2026-02-30") and not is_valid_date("26-1-1") and not is_valid_date(None)
