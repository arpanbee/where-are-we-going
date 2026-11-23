"""Destination list. destinations.json is also served to the browser (web/ links to it)."""

import json
from pathlib import Path

_HERE = Path(__file__).parent

DESTINATIONS = json.loads((_HERE / "destinations.json").read_text(encoding="utf-8"))
BY_ID = {d["id"]: d for d in DESTINATIONS}
FALLBACK_PUZZLES = json.loads((_HERE / "fallback_puzzles.json").read_text(encoding="utf-8"))
