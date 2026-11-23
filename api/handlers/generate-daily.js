// Daily clue generator, invoked by EventBridge Scheduler.
// Ensures PUZZLE#<date> exists for today and the next 6 days (UTC). Each new puzzle
// uses a destination not used in the previous 90 days and starts reviewed=false.

import { generateClues } from "../lib/clues.js";
import { addDays, puzzleNumber, utcToday } from "../lib/dates.js";
import { batchGet, museSpendGuard, putPuzzleIfAbsent, puzzleKey } from "../lib/db.js";
import { LimitError } from "../lib/errors.js";
import { primeMuseApiKey } from "../lib/muse-key.js";
import { pickDestination } from "../lib/pick.js";

primeMuseApiKey();

export const DAYS_AHEAD = 7;
export const REUSE_WINDOW_DAYS = 90;

export async function handler() {
  const today = utcToday();
  const targets = Array.from({ length: DAYS_AHEAD }, (_, i) => addDays(today, i));
  const lookback = Array.from({ length: REUSE_WINDOW_DAYS }, (_, i) => addDays(today, -REUSE_WINDOW_DAYS + i));

  const items = await batchGet([...lookback, ...targets].map(puzzleKey));
  const byDate = new Map(items.map((it) => [it.PK.slice("PUZZLE#".length), it]));
  const lastUsed = new Map(); // destId -> latest date used
  for (const [date, it] of byDate) {
    if (!lastUsed.has(it.destId) || lastUsed.get(it.destId) < date) lastUsed.set(it.destId, date);
  }

  const created = [];
  const skipped = [];
  const failed = [];
  for (const date of targets.filter((d) => !byDate.has(d))) {
    const dest = pickDestination(lastUsed, addDays(date, -REUSE_WINDOW_DAYS));
    lastUsed.set(dest.id, date); // don't pick it again this run
    try {
      const clues = await generateClues(
        { name: dest.name, country: dest.country },
        { beforeCall: museSpendGuard },
      );
      const wrote = await putPuzzleIfAbsent({
        ...puzzleKey(date),
        date,
        num: puzzleNumber(date),
        destId: dest.id,
        clues,
        reviewed: false,
        source: "muse",
        model: process.env.MUSE_MODEL || "muse-spark-1.1",
        createdAt: new Date().toISOString(),
      });
      (wrote ? created : skipped).push({ date, destId: dest.id });
    } catch (err) {
      failed.push({ date, destId: dest.id, error: err.name });
      if (err instanceof LimitError) break; // spend cap hit; the rest would fail too
    }
  }

  const summary = { msg: "daily generation", today, created, skipped, failed };
  console.log(JSON.stringify(summary));
  // Fail the invocation so it shows up in Lambda error metrics; the next run fills gaps.
  if (failed.length) throw new Error(`Failed to generate ${failed.length} puzzle(s): ${failed.map((f) => f.date).join(", ")}`);
  return summary;
}
