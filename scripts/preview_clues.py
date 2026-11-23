#!/usr/bin/env python3
"""Print Muse-generated clues for a destination, to test prompt quality locally.

    api/.venv/bin/python scripts/preview_clues.py <destination> [--hint "where we got engaged"] [--model ID]

Key: MUSE_API_KEY from the environment if set, otherwise the
where-are-we-going/muse-api-key secret via your AWS credentials.
Calls here don't count against the deployed daily spend cap.
"""

import argparse
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))
os.environ.setdefault("AWS_REGION", "us-east-1")

from wawg.clues import ClueGenerationError, _fold, generate_clues  # noqa: E402
from wawg.destinations import DESTINATIONS  # noqa: E402


def find(query: str):
    q = _fold(query.strip())  # case- and accent-insensitive: "galap" finds Galápagos
    return next((d for d in DESTINATIONS if d["id"] == q or _fold(d["name"]) == q), None) or next(
        (d for d in DESTINATIONS if _fold(d["name"]).startswith(q)), None
    )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("destination", nargs="+")
    ap.add_argument("--hint")
    ap.add_argument("--model")
    args = ap.parse_args()
    query = " ".join(args.destination)

    dest = find(query)
    if not dest:
        q = _fold(query)
        close = [d["name"] for d in DESTINATIONS if q in _fold(d["name"]) or q in _fold(d["country"])]
        print(f'"{query}" isn\'t on the destination list.' + (f" Did you mean: {', '.join(close)}?" if close else ""), file=sys.stderr)
        return 1

    def log(e):
        detail = "; ".join(e["problems"]) if "problems" in e else f"{e.get('error')} {e.get('status') or ''}".strip()
        print(f"  ! attempt {e['attempt']}: {detail}", file=sys.stderr)

    print(f"{dest['name']}, {dest['country']}" + (f" (hint: {args.hint})" if args.hint else "") + "\n")
    started = time.time()
    try:
        clues = generate_clues(dest["name"], dest["country"], args.hint, model=args.model, log=log)
    except ClueGenerationError as err:
        cause = f" ({type(err.__cause__).__name__}: {err.__cause__})" if err.__cause__ else ""
        print(f"Failed: {err}{cause}" + "".join(f"\n  {p}" for p in err.problems), file=sys.stderr)
        return 1
    for i, c in enumerate(clues, 1):
        print(f"{i}. {c}")
    print(f"\n({time.time() - started:.1f}s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
