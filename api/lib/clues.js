// LLM clue generation via Meta's Muse API (OpenAI-compatible chat completions).
// Shared by the API Lambda (partner rounds), the daily generator, and
// scripts/preview-clues.js.

import { getMuseApiKey } from "./muse-key.js";

export const MUSE_BASE_URL = "https://api.meta.ai/v1";
export const DEFAULT_MODEL = "muse-spark-1.1";
export const CLUE_COUNT = 6;
export const MAX_CLUE_LENGTH = 120; // each clue must be shorter than this
export const MAX_HINT_LENGTH = 240;
const ATTEMPT_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 2; // first try + one retry
const MIN_RETRY_BUDGET_MS = 3_000;

export class ClueGenerationError extends Error {
  constructor(message, { problems = [], cause } = {}) {
    super(message, { cause });
    this.name = "ClueGenerationError";
    this.problems = problems;
  }
}

class MuseHttpError extends Error {
  constructor(status) {
    super(`Muse API returned HTTP ${status}`);
    this.name = "MuseHttpError";
    this.status = status;
    // Auth and bad-request errors won't improve on retry.
    this.retryable = status === 408 || status === 429 || status >= 500;
  }
}

/** Prompt from genClues() in the prototype, with a stricter JSON-only instruction. */
export function buildPrompt({ name, country, hint }) {
  const note = String(hint ?? "").trim().slice(0, MAX_HINT_LENGTH);
  return (
    `You write clues for a couples' travel guessing game. The answer is "${name}" (${country}). ` +
    `Write exactly 6 clues from vague to specific: clue 1 is about the vibe, weather, food or what to pack; ` +
    `each later clue narrows it down; clue 6 is nearly a giveaway. ` +
    `Never use the destination's name, the country's name, or words formed from them. ` +
    `Every clue must be factually accurate and under 16 words.` +
    (note
      ? ` The person setting the puzzle left a private hint about why this place matters to the couple. ` +
        `If it fits, turn it into clue 3 or 4 without naming the place. Hint: ${JSON.stringify(note)}`
      : "") +
    ` Reply with only a JSON array of 6 strings. No prose, no markdown, no code fences.`
  );
}

/** Pulls a clue array out of the model's reply. Returns null if there isn't one. */
export function parseClues(text) {
  const s = String(text ?? "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const tryParse = (t) => {
    try {
      const v = JSON.parse(t);
      if (Array.isArray(v)) return v;
      if (v && Array.isArray(v.clues)) return v.clues;
    } catch {}
    return null;
  };
  const direct = tryParse(s);
  if (direct) return direct;
  // Tolerate a sentence wrapped around the array.
  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  return start >= 0 && end > start ? tryParse(s.slice(start, end + 1)) : null;
}

const fold = (s) =>
  String(s)
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Words clues 1–5 must not contain: the destination name and each country.
 * "Zambia / Zimbabwe" yields both countries.
 */
export function forbiddenTerms({ name, country }) {
  return [name, ...String(country).split("/")]
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * Returns a list of problems, or [] when the clues are valid.
 * Matching is case- and accent-insensitive and anchored at the start of a word, so
 * "Peru" also catches "Peruvian" but "UK" doesn't trip on "duke".
 */
export function validateClues(clues, dest) {
  if (!Array.isArray(clues)) return ["reply was not a JSON array"];
  const problems = [];
  if (clues.length !== CLUE_COUNT) problems.push(`expected ${CLUE_COUNT} clues, got ${clues.length}`);
  const patterns = forbiddenTerms(dest).map((t) => ({
    term: t,
    re: new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(fold(t))}`, "u"),
  }));
  clues.slice(0, CLUE_COUNT).forEach((c, i) => {
    const n = i + 1;
    if (typeof c !== "string" || !c.trim()) {
      problems.push(`clue ${n} is empty or not a string`);
      return;
    }
    if (c.trim().length >= MAX_CLUE_LENGTH) {
      problems.push(`clue ${n} is ${c.trim().length} characters (must be under ${MAX_CLUE_LENGTH})`);
    }
    if (n <= 5) {
      const f = fold(c);
      for (const { term, re } of patterns) {
        if (re.test(f)) problems.push(`clue ${n} names "${term}"`);
      }
    }
  });
  return problems;
}

/**
 * Generates 6 validated clues for a destination. Retries once on an invalid reply
 * or a transient API error, then throws ClueGenerationError.
 *
 * @param {{name: string, country: string, hint?: string}} dest
 * @param {object} [opts]
 * @param {() => Promise<void>} [opts.beforeCall] Runs before every HTTP attempt
 *   (spend cap). Throw from it to stop; the error propagates unchanged.
 * @param {number} [opts.deadline] Epoch ms by which to give up. Attempt timeouts
 *   shrink to fit, and the retry is skipped if too little time remains.
 * @param {string} [opts.model] Defaults to MUSE_MODEL env, then DEFAULT_MODEL.
 * @param {string} [opts.apiKey] Defaults to the cached Secrets Manager key.
 * @param {typeof fetch} [opts.fetchImpl] For tests.
 * @param {(event: object) => void} [opts.log] Receives attempt diagnostics (never the key).
 * @returns {Promise<string[]>}
 */
export async function generateClues({ name, country, hint }, opts = {}) {
  const {
    beforeCall,
    deadline = Infinity,
    model = process.env.MUSE_MODEL || DEFAULT_MODEL,
    fetchImpl = fetch,
    log = (e) => console.warn(JSON.stringify(e)),
  } = opts;
  const dest = { name, country };
  const prompt = buildPrompt({ name, country, hint });
  let lastError;
  let feedback = "";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const remaining = deadline - Date.now();
    const timeout = Math.min(ATTEMPT_TIMEOUT_MS, remaining - 500);
    if (attempt > 1 && timeout < MIN_RETRY_BUDGET_MS) break;

    if (beforeCall) await beforeCall();
    const apiKey = opts.apiKey ?? (await getMuseApiKey());

    try {
      const content = await callMuse({ apiKey, model, prompt: prompt + feedback, timeout, fetchImpl });
      const clues = parseClues(content);
      const problems = validateClues(clues, dest);
      if (problems.length === 0) return clues.map((c) => c.trim());
      lastError = new ClueGenerationError("Muse reply failed validation", { problems });
      log({ msg: "clue validation failed", destination: name, attempt, problems });
      feedback = ` Your previous reply had these problems, fix them: ${problems.join("; ")}.`;
    } catch (err) {
      lastError = err;
      log({ msg: "muse call failed", destination: name, attempt, error: err.name, status: err.status });
      if (err instanceof MuseHttpError && !err.retryable) break;
    }
  }

  if (lastError instanceof ClueGenerationError) throw lastError;
  throw new ClueGenerationError(`Couldn't generate clues for ${name}`, { cause: lastError });
}

async function callMuse({ apiKey, model, prompt, timeout, fetchImpl }) {
  const res = await fetchImpl(`${MUSE_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: "You reply with JSON only." },
        { role: "user", content: prompt },
      ],
      max_tokens: 600,
    }),
    signal: AbortSignal.timeout(Math.max(1, timeout)),
  });
  // Deliberately don't log response bodies: error payloads can echo request details.
  if (!res.ok) throw new MuseHttpError(res.status);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? "";
}
