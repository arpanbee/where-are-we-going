# Where Are We Going? — handoff for AWS build

A daily Wordle-style travel guessing game for couples. `where-are-we-going.html` is a working prototype: a single page with all game logic, the destination list, and 14 hand-written daily puzzles. It was built on claude.ai, where shared state came from the host (`claude.use("db" | "user" | "sample")`). The job is to replace those three calls with our own AWS backend and keep the frontend behavior the same.

## What the prototype does (keep this behavior)

- **Daily puzzle**: one destination per day, the same for everyone. 6 clues, vague to specific. Clue 1 shows at the start and each wrong guess unlocks the next. Max 6 guesses.
- **Guess input**: autocomplete from a fixed list of ~125 destinations (`RAW` in the script: `name|country|lat|lon`). Free text is not allowed, so distance can always be computed.
- **Feedback per guess**: haversine distance in km, 8-way bearing arrow, colour tier: green = correct, yellow < 500 km, orange < 2,000 km, red otherwise.
- **Scoring**: solved in n guesses = `7 - n` points; a miss = 0.
- **Couples**: one partner creates a 6-character code and the other joins with it. Max 2 members.
- **Partner result hidden** until you finish your own puzzle (enforce this server-side in the real build).
- **Weekly score**: sum of daily points Monday–Sunday in local time.
- **Partner rounds**: a player picks a destination plus an optional private hint, the LLM writes 6 clues, the player can edit them, then sends to their partner. Reject sending if clues 1–5 contain the destination name.
- **Shared bucket list**: after each puzzle, a "We should go" / "Not for me" vote. Places both partners voted yes on form "Trips we both want".
- **Share text**: a Wordle-style emoji grid plus the weekly score line.

## Target architecture (suggested)

| Concern | Prototype | AWS |
|---|---|---|
| Static site | claude.ai artifact | S3 + CloudFront (OAC), custom domain via Route 53 + ACM |
| Identity | Claude account (`user.id()`) | Anonymous device token (UUID in localStorage, sent as a header) to start. Add Cognito later if accounts are needed. |
| Shared state | `db` (Firestore-like) | API Gateway (HTTP API) + Lambda (Node 20) + DynamoDB (single table) |
| Live updates | `onSnapshot` | Polling every 15–30 s while the tab is visible is fine for an async game. Add API Gateway WebSockets only if needed. |
| Daily clues | hard-coded `DAILY` array | EventBridge Scheduler, daily, calls a Lambda that uses the Meta Model API (Muse Spark) to write clues a week ahead into DynamoDB. Keep a human review flag. |
| Partner-round clues | `claude.use("sample")` | Lambda calls the Meta Model API. Key in Secrets Manager. Rate-limit per couple. |
| IaC | n/a | Terraform |

Meta Model API: OpenAI-compatible, base URL `https://api.meta.ai/v1`, model `muse-spark-1.1`. Ask for a JSON array of 6 strings. The prompt is in `genClues()` in the prototype.

## Fix in the real build

- **Answers are in the page source** in the prototype. The API should return only the clues unlocked so far, and judge guesses server-side.
- **Partner results** must only come back from the API once the requester has finished that puzzle.
- **Use the player's local date** for "today" (send the client's tz offset or date), or pick one global reset time and say so in the UI.
- **Budget guard**: a global daily spend cap on LLM calls, plus a per-couple cap on partner rounds per day.

## DynamoDB single-table sketch

| PK | SK | Item |
|---|---|---|
| `PUZZLE#2026-11-23` | `META` | destId, clues[6], reviewed |
| `COUPLE#ABC123` | `META` | members[2], created |
| `COUPLE#ABC123` | `PLAY#d2026-11-23#<uid>` | guesses[], done, solved, points, date |
| `COUPLE#ABC123` | `ROUND#<id>` | from, to, destId, clues[6], created |
| `COUPLE#ABC123` | `VOTE#<destId>#<uid>` | v |
| `USER#<uid>` | `COUPLE` | code |

## API sketch

- `POST /couples` → `{code}`
- `POST /couples/{code}/join`
- `GET /today` → `{num, cluesUnlocked[], myPlay}`
- `POST /today/guess {destId}` → updated play (server checks the answer)
- `GET /couples/{code}/state` → partner status (result only if mine is done), week scores, rounds, votes
- `POST /couples/{code}/rounds {destId, hint}` → generated clues (draft)
- `POST /couples/{code}/rounds/{id}/send {clues[]}`
- `POST /couples/{code}/votes {destId, v}`

## Suggested order

1. Repo layout: `web/` (prototype split into HTML/CSS/JS), `api/` (Lambdas), `infra/` (Terraform).
2. Static hosting first, with the prototype running solo from localStorage.
3. DynamoDB + couples + plays + server-side guess checking.
4. Weekly score, partner rounds (Meta API), votes.
5. Daily clue generator + review step.
