// HTTP API (payload v2) entry point. CloudFront routes /api/* here.
// Routes in this file so far:
//   GET  /api/today?date=YYYY-MM-DD
//   POST /api/couples/{code}/rounds   {destId, hint?}
// Couple create/join, guesses and state are step 3 (see docs/PLAN.md).

import { createHash } from "node:crypto";
import { BY_ID } from "../lib/destinations.js";
import { ClueGenerationError, generateClues, MAX_HINT_LENGTH } from "../lib/clues.js";
import { addDays, isValidDate, utcToday } from "../lib/dates.js";
import { ROUND_DRAFTS_PER_DAY, getItem, museSpendGuard, takeQuota } from "../lib/db.js";
import { HttpError, LimitError } from "../lib/errors.js";
import { primeMuseApiKey } from "../lib/muse-key.js";
import { getPuzzle } from "../lib/puzzles.js";

primeMuseApiKey(); // fetch the key during cold start, cached for the container's life

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_RE = /^[A-Z0-9]{6}$/;
// Keep under API Gateway's 30 s integration limit (Lambda timeout is 29 s).
const RESPONSE_MARGIN_MS = 1_500;

const json = (status, body) => ({
  statusCode: status,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
  body: JSON.stringify(body),
});

export async function handler(event, context) {
  const method = event.requestContext?.http?.method;
  const path = event.rawPath ?? "";
  try {
    if (method === "GET" && path === "/api/today") return json(200, await getToday(event));
    const m = path.match(/^\/api\/couples\/([^/]+)\/rounds$/);
    if (method === "POST" && m) return json(200, await draftRound(event, context, m[1]));
    return json(404, { error: "Not found." });
  } catch (err) {
    if (err instanceof HttpError) return json(err.status, { error: err.message });
    if (err instanceof ClueGenerationError) {
      console.warn(JSON.stringify({ msg: "clue generation failed", problems: err.problems, cause: err.cause?.name }));
      return json(502, { error: "Couldn't write clues just now. You can write them yourself." });
    }
    console.error(JSON.stringify({ msg: "unhandled error", path, error: err?.name, message: err?.message }));
    return json(500, { error: "Something went wrong. Try again in a moment." });
  }
}

/**
 * Today's puzzle for the player's local date. Accepts dates within a day of UTC
 * today so every time zone works without exposing future puzzles.
 * Only clue 1 is returned until guesses are judged server-side (step 3).
 */
async function getToday(event) {
  const today = utcToday();
  const date = event.queryStringParameters?.date ?? today;
  if (!isValidDate(date) || date < addDays(today, -1) || date > addDays(today, 1)) {
    throw new HttpError(400, "That date isn't available.");
  }
  const p = await getPuzzle(date);
  return {
    date: p.date,
    num: p.num,
    source: p.source,
    reviewed: p.reviewed,
    totalClues: p.clues.length,
    cluesUnlocked: p.clues.slice(0, 1),
  };
}

/** Draft 6 clues for a partner round. Nothing is stored until it's sent (step 4). */
async function draftRound(event, context, rawCode) {
  const uid = requireUid(event);
  const code = decodeURIComponent(rawCode).toUpperCase();
  if (!CODE_RE.test(code)) throw new HttpError(404, "No couple found with that code.");

  const couple = await getItem({ PK: `COUPLE#${code}`, SK: "META" });
  // Same response for "no such couple" and "not a member", so codes can't be probed.
  if (!couple || !Array.isArray(couple.members) || !couple.members.includes(uid)) {
    throw new HttpError(404, "No couple found with that code.");
  }

  const body = parseBody(event);
  const dest = BY_ID[body.destId];
  if (!dest) throw new HttpError(400, "Pick a destination from the list.");
  if (body.hint != null && typeof body.hint !== "string") throw new HttpError(400, "The hint must be text.");
  const hint = (body.hint ?? "").trim().slice(0, MAX_HINT_LENGTH);

  const ok = await takeQuota(`LIMIT#rounds#${code}#${utcToday()}`, ROUND_DRAFTS_PER_DAY);
  if (!ok) {
    throw new LimitError(
      `You've drafted ${ROUND_DRAFTS_PER_DAY} partner rounds today. Try again tomorrow, or write the clues yourself.`,
    );
  }

  const clues = await generateClues(
    { name: dest.name, country: dest.country, hint },
    { beforeCall: museSpendGuard, deadline: Date.now() + context.getRemainingTimeInMillis() - RESPONSE_MARGIN_MS },
  );
  return { draft: { destId: dest.id, clues } };
}

/** Anonymous identity: a UUID device token; we store only its hash. */
function requireUid(event) {
  const token = event.headers?.["x-device-token"] ?? "";
  if (!UUID_RE.test(token)) throw new HttpError(401, "Missing or invalid device token.");
  return createHash("sha256").update(token.toLowerCase()).digest("hex");
}

function parseBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  if (raw.length > 4_096) throw new HttpError(413, "Request too large.");
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v : {};
  } catch {
    throw new HttpError(400, "Request body must be JSON.");
  }
}
