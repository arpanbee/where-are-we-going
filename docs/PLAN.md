# AWS build plan

Follows the suggested order in [HANDOFF.md](../HANDOFF.md). Status: steps 1–2 done and deployed; Muse clue generation (parts of steps 3–5) deployed; couples, plays, guesses, votes and the frontend API client still to do.

## Layout

```
web/        index.html, styles.css, app.js. Static frontend, no build step yet.
api/        Lambda handlers + shared lib (Node 22, ESM). `npm test` runs unit tests.
infra/      Terraform root module (one file per concern: site.tf, dns.tf, api.tf)
infra/bootstrap/   one-time remote-state bucket (local state)
scripts/    deploy-web.sh, preview-clues.js
```

A single root module with files grouped by concern, rather than `modules/` and `envs/`. There's one environment today. Pull out modules when a second environment arrives.

## Decisions that cut across steps

- **Same origin for the API.** CloudFront serves `/*` from S3 and `/api/*` from the HTTP API (step 3). This means no CORS, a CSP of `connect-src 'self'`, and one domain.
- **State:** S3 backend with `use_lockfile` (native S3 locking, Terraform ≥ 1.10). No DynamoDB lock table.
- **Region:** `us-east-1` by default. ACM for CloudFront must be in us-east-1 anyway, and keeping everything there simplifies things. This can be changed through `var.region`.
- **Frontend deploys are separate from infra.** Terraform owns the bucket and distribution. `scripts/deploy-web.sh` syncs files and invalidates the cache.
- **Identity:** an anonymous UUID device token in localStorage, sent as `X-Device-Token`. Lambda hashes it and uses the hash as the uid. Never log the raw token.
- **"Today":** the client sends its local date `YYYY-MM-DD`. The server accepts it only within ±1 day of UTC "now". Otherwise people could fetch future puzzles. Puzzles are keyed by date.

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

- `api/lib/clues.js`: `generateClues({name, country, hint?})` calls `https://api.meta.ai/v1/chat/completions` with model `MUSE_MODEL` (default `muse-spark-1.1`) and the prototype's prompt. It checks for exactly 6 non-empty clues, each under 120 characters, with clues 1–5 free of the name and country. The check ignores case and accents and matches at the start of a word, so "Peruvian" is caught for Peru but "duke" isn't caught for UK. Each attempt has a 20 s timeout. It retries once (sending the problems back to the model), then throws.
- The key lives in Secrets Manager (`where-are-we-going/muse-api-key`, created outside Terraform). Lambda fetches it at cold start and caches it. Terraform reads only the secret's ARN, and the Lambda role can call `GetSecretValue` on that ARN only.
- Spend cap: `LIMIT#muse#<utc-date>` counts every HTTP attempt, retries included. Past `MUSE_DAILY_CALL_LIMIT` (500), callers get a 429.
- `POST /api/couples/{code}/rounds {destId, hint?}` returns a draft (nothing is stored yet). It requires an `X-Device-Token` that belongs to a couple member, and allows 10 drafts per couple per UTC day (`LIMIT#rounds#<code>#<date>`).
- The daily generator (EventBridge Scheduler, 03:00 UTC) ensures `PUZZLE#<date>` exists for today plus the next 6 days. It picks a destination not used in the last 90 days and writes with `reviewed=false`, using a conditional put so an existing or reviewed puzzle is never overwritten.
- `GET /api/today?date=` serves the stored puzzle whether or not it has been reviewed, and otherwise the prototype's hand-written rotation. For now it returns only clue 1, until server-side guessing exists.
- To test prompt quality locally: `node scripts/preview-clues.js "Machu Picchu" [--hint ...]`. This uses `MUSE_API_KEY` from the environment, or the secret via your AWS credentials, and doesn't count toward the cap.

## Step 3 — DynamoDB, couples, plays, server-side guesses

Infra (`data.tf`, `api.tf`):
- DynamoDB table `wawg-prod`: PK/SK strings, on-demand billing, PITR, TTL attribute `ttl` (used for rate-limit counters). Use the single-table sketch from HANDOFF.
- An HTTP API (API Gateway v2) with a single Lambda proxy (`api/`, Node 20, arm64). Use a small router rather than one Lambda per route, because the app is tiny and cold starts matter more than isolation here.
- IAM: Lambda gets least-privilege access to the table ARN only (GetItem/PutItem/UpdateItem/Query/TransactWriteItems).
- Stage throttling for a coarse global rate limit. The CloudFront `/api/*` behavior uses CachingDisabled and an origin request policy that forwards `X-Device-Token`.
- CloudWatch log group with 14-day retention.

App:
- `GET /api/today?date=` returns `{num, clues[0..unlocked], myPlay}`. `destId` is never returned until the play is done.
- `POST /api/today/guess {date, destId}`. The server validates the destination, appends the guess, computes `done/solved/points`, and returns the play plus the distance, bearing and tier for each guess. The destination list moves to a shared module that both web and api import.
- Couples: create (a conditional put retried on collision), join (a transaction: update members if the size is < 2, and put `USER#uid/COUPLE`), and leave.
- `GET /api/couples/{code}/state`. The partner's play is redacted to "not started / guessing / finished" unless the requester's own play is done.
- Puzzles: seed `PUZZLE#date` items from the existing 14 hand-written puzzles with a one-off script.
- Frontend: replace `use()` with `api.js` and poll `/state` every 20 s while `document.visibilityState === 'visible'`. Remove `DAILY` and the answers from the bundle.

## Step 4 — weekly score, partner rounds, votes

- Weekly score is computed server-side from `PLAY#d<date>` items in the requester's Monday-to-Sunday range. Use `begins_with` / `between` on SK.
- Rounds: `POST /rounds` calls the Meta Model API (`https://api.meta.ai/v1`, `muse-spark-1.1`, OpenAI-compatible chat completions) with the prompt from `genClues()`, and returns draft clues. `POST /rounds/{id}/send` validates that there are 6 non-empty clues and that clues 1–5 don't contain the destination name, then writes the round. The recipient fetches it without `destId`, and guesses go through the same server-side judge.
- Secrets Manager stores the Meta API key, and Lambda reads it with in-memory caching.
- Budget guard: a DynamoDB atomic counter `LIMIT#llm#<utc-date>` (global daily cap) and `LIMIT#round#<code>#<date>` (per couple), both with TTL. Exceeding either returns 429 with friendly copy. AWS Budgets sends an email alert for the account.
- Votes: `POST /votes`. "Trips we both want" is derived in `/state`.

## Step 5 — daily clue generator and review

- An EventBridge Scheduler (daily, UTC) triggers a generator Lambda. It keeps 7 days of puzzles ahead, picking destinations not used in the last N days, and writes `PUZZLE#date` with `reviewed=false`.
- Review: an admin-only path such as `GET/POST /api/admin/puzzles` behind an IAM-authorized route or a shared secret, or simply a CLI script that runs against DynamoDB. The CLI is simplest to start with. `GET /today` serves only `reviewed=true`, and falls back to the oldest reviewed spare if the day's puzzle isn't ready.
- An alarm fires if fewer than 2 reviewed days remain ahead.

## Open questions (answer before step 3)

1. Custom domain: which one, and is its hosted zone in this account?
2. Global reset time versus the player's local date. The plan above uses local date with a ±1 day guard. That means two people in different time zones can be on different puzzles at the same moment.
3. Is there an existing Meta Model API key, and what is the daily spend cap?
