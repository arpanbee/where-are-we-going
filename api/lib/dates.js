// Dates are "YYYY-MM-DD" strings, interpreted as calendar days (no time zone math).

const DAY_MS = 86_400_000;
export const FIRST_PUZZLE_DATE = "2026-11-22"; // puzzle #1, same as the prototype's START
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const toMs = (ymd) => Date.parse(`${ymd}T00:00:00Z`);
const fromMs = (ms) => new Date(ms).toISOString().slice(0, 10);

export const utcToday = (now = Date.now()) => fromMs(now);
export const addDays = (ymd, n) => fromMs(toMs(ymd) + n * DAY_MS);
export const daysBetween = (a, b) => Math.round((toMs(b) - toMs(a)) / DAY_MS);

export function isValidDate(s) {
  return typeof s === "string" && DATE_RE.test(s) && fromMs(toMs(s)) === s;
}

/** Puzzle number shown to players (#1 on FIRST_PUZZLE_DATE). */
export const puzzleNumber = (ymd) => Math.max(0, daysBetween(FIRST_PUZZLE_DATE, ymd)) + 1;
