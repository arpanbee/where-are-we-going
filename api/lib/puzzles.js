import { getItem, puzzleKey } from "./db.js";
import { FALLBACK_PUZZLES } from "./fallback-puzzles.js";
import { FIRST_PUZZLE_DATE, daysBetween, puzzleNumber } from "./dates.js";

/**
 * The puzzle for a date: the PUZZLE#<date> item whether or not it's reviewed,
 * otherwise the prototype's hand-written puzzle for that day (same rotation as the
 * prototype, so existing players see the same answer).
 */
export async function getPuzzle(date) {
  const item = await getItem(puzzleKey(date));
  const base = { date, num: puzzleNumber(date) };
  if (item && Array.isArray(item.clues) && item.clues.length === 6) {
    return { ...base, destId: item.destId, clues: item.clues, source: "generated", reviewed: Boolean(item.reviewed) };
  }
  const day = Math.max(0, daysBetween(FIRST_PUZZLE_DATE, date));
  const fb = FALLBACK_PUZZLES[day % FALLBACK_PUZZLES.length];
  return { ...base, destId: fb.destId, clues: fb.clues, source: "fallback", reviewed: true };
}
