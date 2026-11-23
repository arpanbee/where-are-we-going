# AWS build plan

Follows the suggested order in [HANDOFF.md](../HANDOFF.md). Status: steps 1–3 deployed (Python backend); step 4 built and tested, not yet deployed; step 5 review tooling and alarms to do.

## Layout

```
web/        index.html, styles.css, app.js. Static frontend, no build step yet.
api/        Python 3.13 Lambda package `wawg/` (no third-party deps; boto3 is in the runtime).
            Dev: `python3 -m venv api/.venv && api/.venv/bin/pip install -r api/requirements-dev.txt`,
            then `cd api && .venv/bin/python -m pytest`.
infra/      Terraform root module (one file per concern: site.tf, dns.tf, api.tf)
infra/bootstrap/   one-time remote-state bucket (local state)
scripts/    deploy-web.sh, preview_clues.py
```

A single root module with files grouped by concern, rather than `modules/` and `envs/`. There's one environment today. Pull out modules when a second environment arrives.

## Decisions that cut across steps

- **Same origin for the API.** CloudFront serves `/*` from S3 and `/api/*` from the HTTP API (step 3). This means no CORS, a CSP of `connect-src 'self'`, and one domain.
- **State:** S3 backend with `use_lockfile` (native S3 locking, Terraform ≥ 1.10). No DynamoDB lock table.
- **Region:** `us-east-1` by default. ACM for CloudFront must be in us-east-1 anyway, and keeping everything there simplifies things. This can be changed through `var.region`.
- **Frontend deploys are separate from infra.** Terraform owns the bucket and distribution. `scripts/deploy-web.sh` syncs files and invalidates the cache.
- **Identity:** an anonymous UUID device token in localStorage, sent as `X-Device-Token`. Lambda hashes it and uses the hash as the uid. Never log the raw token.
- **"Today":** the client sends its local date `YYYY-MM-DD`. The server accepts it only within ±1 day of UTC "now". Otherwise people could fetch future puzzles. Puzzles are keyed by date.

## Backend language

The backend was ported from Node to Python before step 3 shipped (same routes, data model and behaviour). Parity check: `judge()` matched on all 15,625 destination pairs (except that due north is now reported as bearing 0 instead of 360), and the clue validator matched on the edge cases.

## Step 1 — repo layout ✅

- The prototype is split into `web/index.html`, `web/styles.css`, and `web/app.js`, and the original file is kept for reference. The JS is unchanged apart from one string: the Pair tab no longer says "sign in to Claude".
- The `claude.use()` shim stays in place for now. It returns null outside claude.ai, so the app runs in solo/localStorage mode. Step 3 replaces it with an `api.js` client.

## Step 2 — static hosting ✅

`infra/site.tf` and `infra/dns.tf` set up the following:
- A private S3 bucket. All public access is blocked, BucketOwnerEnforced is on, SSE-S3 encryption is on, versioning is on, and noncurrent versions expire after 30 days. A TLS-only bucket policy allows reads only from this distribution (OAC, SigV4).
- CloudFront with the managed CachingOptimized policy, HTTP/2+3, IPv6, and PriceClass_100.
- A response headers policy with a strict CSP (self + Google Fonts), HSTS, nosniff, `X-Frame-Options: DENY`, and a referrer policy.
- An optional custom domain. When `domain_name` and `hosted_zone_name` are set, you get an ACM cert in us-east-1, DNS validation, and Route 53 A/AAAA aliases. Otherwise the site uses `*.cloudfront.net`.

Apply:
```sh
cd infra/bootstrap && terraform init && terraform apply      # once
terraform output -raw backend_hcl > ../backend.hcl
cd .. && terraform init -backend-config=backend.hcl
terraform apply                       # optionally with terraform.tfvars for a domain
../scripts/deploy-web.sh
```
Done when the site URL loads, a daily puzzle can be played solo, results persist across a reload, and the response headers include the CSP. Also check the browser console for no CSP violations.

## Muse clue generation ✅ (pulled forward from steps 4–5)

Built ahead of the rest of steps 3–5. The table, the API Lambda behind `/api/*`, and the scheduler already exist.

- `api/wawg/clues.py`: `generate_clues(name, country, hint=None)` calls `https://api.meta.ai/v1/chat/completions` with model `MUSE_MODEL` (default `muse-spark-1.1`) and the prototype's prompt. It checks for exactly 6 non-empty clues, each under 120 characters, with clues 1–5 free of the name and country. The check ignores case and accents and matches at the start of a word, so "Peruvian" is caught for Peru but "duke" isn't caught for UK. Each attempt has a 20 s timeout. It retries once (sending the problems back to the model), then raises.
- The key lives in Secrets Manager (`where-are-we-going/muse-api-key`, created outside Terraform). Lambda fetches it at cold start and caches it. Terraform reads only the secret's ARN, and the Lambda role can call `GetSecretValue` on that ARN only.
- Spend cap: `LIMIT#muse#<utc-date>` counts every HTTP attempt, retries included. Past `MUSE_DAILY_CALL_LIMIT` (500), callers get a 429.
- `POST /api/couples/{code}/rounds {destId, hint?}` returns a draft (nothing is stored yet). It requires an `X-Device-Token` that belongs to a couple member, and allows 10 drafts per couple per UTC day (`LIMIT#rounds#<code>#<date>`).
- The daily generator (EventBridge Scheduler, 03:00 UTC) ensures `PUZZLE#<date>` exists for today plus the next 6 days. It picks a destination not used in the last 90 days and writes with `reviewed=false`, using a conditional put so an existing or reviewed puzzle is never overwritten.
- `GET /api/today?date=` serves the stored puzzle whether or not it has been reviewed, and otherwise the prototype's hand-written rotation. For now it returns only clue 1, until server-side guessing exists.
- To test prompt quality locally: `api/.venv/bin/python scripts/preview_clues.py "Machu Picchu" [--hint ...]`. This uses `MUSE_API_KEY` from the environment, or the secret via your AWS credentials, and doesn't count toward the cap.

## Step 3 — couples, plays, server-side guesses ✅ (code), ⏳ (deploy)

Data (single table, alongside the puzzle and counter items):

| PK | SK | Item |
|---|---|---|
| `USER#<uid>` | `PLAY#<date>` | destId, clues (snapshot), guesses[], done, solved, points |
| `USER#<uid>` | `COUPLE` | code |
| `COUPLE#<code>` | `META` | members[≤2], created |

- Plays are keyed **per user**, not per couple as in the handoff sketch. Solo players need server-side plays too, and history survives leaving a couple. The partner view reads the partner's own item.
- A play snapshots the puzzle's answer and clues at the first request, so a puzzle that gets generated or edited mid-day can't change an answer someone is already playing.
- Guesses use the guess count as an optimistic lock (two tabs can't both write; the loser gets a 409). Couple create, join and leave are transactions over the couple item plus the user's pointer.
- `uid` = SHA-256 of the `X-Device-Token` UUID that the client keeps in localStorage. Clearing site data loses the identity; add Cognito later if that matters.

API (all under `/api`):
- `GET /today?date=` returns the unlocked clues, per-guess feedback (km, bearing, tier) and the answer only once done. It works without a token (clue 1 only).
- `POST /today/guess {date, destId}`
- `GET /state?date=` returns the couple, the partner's status (with the result only once mine is done) and Monday-to-Sunday week points for both. This replaces the handoff's `GET /couples/{code}/state`, keyed by the caller's own couple.
- `POST /couples`, `POST /couples/{code}/join`, `POST /couples/leave`

Frontend: `web/api.js` client, polling `/state` every 20 s while visible, local-midnight rollover. The answers, `DAILY` and claude.ai hooks are gone from the bundle. `web/destinations.json` is a symlink to `api/wawg/destinations.json` (one list, fetched at startup). While paired, partner rounds and the shared list say "coming soon", and votes stay on-device until step 4.

Tests: `pytest` covers the game rules (distance tiers, unlocking, scoring, redaction, weeks). The end-to-end flow (create, join, third person blocked, redaction, scoring, leave) was run against the real table with throwaway users and cleaned up afterwards.

## Step 4 — partner rounds, bucket list ✅ (code), ⏳ (deploy)

Data:

| PK | SK | Item |
|---|---|---|
| `COUPLE#<code>` | `ROUND#<ms><hex6>` | from, to, destId, clues[6], created, guesses[], done, solved, points |
| `USER#<uid>` | `VOTE#<destId>` | v (1 = we should go, 0 = not for me) |

- **Rounds** live under the couple, with time-sortable ids so a descending query lists the newest first. Only the recipient plays, so their play is stored on the round item itself, with the same judge and the same optimistic lock as daily puzzles. Rounds don't count toward the weekly score (same as the prototype).
- **Drafts aren't stored.** `POST /couples/{code}/rounds` returns Muse clues to edit, and `…/rounds/send` validates them and writes the round. This differs from the handoff's `/rounds/{id}/send`: storing drafts would only make sense if they had to survive a reload.
- **Send validation:** 6 non-empty clues of at most 160 characters each, and clues 1–5 must not name the place. The name check is case- and accent-insensitive and matches at the start of a word, the same as for generated clues. Limit: 20 sends per couple per day.
- **Votes are per player** (not per couple, as in the handoff sketch), so they work solo and survive leaving a couple. Votes saved in the browser before this step are uploaded once on the next visit.
- **No spoilers:** `GET /list` never shows a partner's yes vote for a place that is the answer to a daily puzzle (yesterday, today or tomorrow, to cover time zones) or an inbox round you haven't finished.

API (all under `/api`):
- `POST /couples/{code}/rounds {destId, hint?}` returns a Muse draft (10 per couple per day, plus the global Muse cap)
- `POST /couples/{code}/rounds/send {destId, clues[6]}`
- `GET /couples/{code}/rounds` returns the inbox (no destId until you've finished) and the rounds you sent (with destId and your partner's progress)
- `GET /couples/{code}/rounds/{id}` and `POST …/{id}/guess {destId}`, for the recipient only. Anyone else gets a 404.
- `POST /votes {destId, v}` and `GET /list?date=`

Tests: 26 unit tests. Step 4 end-to-end: 26 checks against the real table (including one live Muse draft), all cleaned up afterwards. The step 3 flow was rerun with no regressions.

## Step 5 — daily clue generator and review

- An EventBridge Scheduler (daily, UTC) triggers a generator Lambda. It keeps 7 days of puzzles ahead, picking destinations not used in the last N days, and writes `PUZZLE#date` with `reviewed=false`.
- Review: an admin-only path such as `GET/POST /api/admin/puzzles` behind an IAM-authorized route or a shared secret, or simply a CLI script that runs against DynamoDB. The CLI is simplest to start with. By decision, `GET /today` serves puzzles whether or not they're reviewed (falling back to the hand-written rotation), so `reviewed` records whether a human has checked one.
- An alarm fires if fewer than 2 reviewed days remain ahead.

## Open questions

1. (Answered: wawg.olsongallery.com.)
2. Global reset time versus the player's local date. The plan above uses local date with a ±1 day guard. That means two people in different time zones can be on different puzzles at the same moment.
3. (Answered: key in Secrets Manager; cap 500 Muse calls/day; $5/month AWS budget.)
