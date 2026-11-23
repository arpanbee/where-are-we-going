from wawg import votes
from wawg.destinations import BY_ID
from wawg.rounds import ROUND_ID_RE, check_clues, new_round_id

OK = ["Pack sandals.", "Hot days.", "Old trams.", "Seven hills.", "A red bridge.", "It's Lisbon."]
LISBON = BY_ID["lisbon"]


def test_round_clues_valid():
    assert check_clues(OK, LISBON) == []


def test_round_clues_need_six_nonempty():
    assert check_clues(OK[:5], LISBON) == ["Fill in all 6 clues first."]
    assert check_clues([*OK[:5], "  "], LISBON) == ["Fill in all 6 clues first."]
    assert check_clues(None, LISBON) == ["Fill in all 6 clues first."]
    assert check_clues([*OK[:5], 6], LISBON) == ["Fill in all 6 clues first."]


def test_round_clues_length_and_giveaway():
    assert "under 160" in check_clues(["x" * 161, *OK[1:]], LISBON)[0]
    assert "names the place" in check_clues(["We met in LISBON", *OK[1:]], LISBON)[0]
    cancun = BY_ID["cancu-n"]
    assert "names the place" in check_clues(["cancun nights", *OK[1:]], cancun)[0]
    # Country is fine for hand-written clues (prototype rule: only the name is blocked).
    assert check_clues(["Portugal!", *OK[1:]], LISBON) == []


def test_round_ids_are_time_sortable():
    a = new_round_id()
    assert ROUND_ID_RE.match(a)
    assert a < f"{int(a[:13]) + 1:013d}000000"


def test_bucket_list(monkeypatch):
    data = {
        "me": {"paris": 1, "rome": 1, "tokyo": 0},
        "them": {"paris": 1, "bali": 1, "kyoto": 1, "tokyo": 1, "rome": 0},
    }
    monkeypatch.setattr(votes, "votes_of", lambda uid: data[uid])
    out = votes.bucket_list("me", "them", hidden={"kyoto"})
    assert out["both"] == ["paris"]
    assert out["onlyMe"] == ["rome"]
    # bali: partner yes, I haven't voted. kyoto hidden (an answer I haven't reached).
    # tokyo: I already voted no, so it isn't suggested.
    assert out["partnerWants"] == ["bali"]
    solo = votes.bucket_list("me", None, hidden=set())
    assert solo["both"] == [] and solo["onlyMe"] == ["paris", "rome"] and solo["partnerWants"] == []
