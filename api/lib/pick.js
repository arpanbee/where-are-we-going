import { DESTINATIONS } from "./destinations.js";

/**
 * Random destination not used on or after `cutoff`. If every destination was used
 * inside the window, falls back to the least recently used one.
 */
export function pickDestination(lastUsed, cutoff, random = Math.random) {
  const fresh = DESTINATIONS.filter((d) => !(lastUsed.get(d.id) >= cutoff));
  if (fresh.length) return fresh[Math.floor(random() * fresh.length)];
  return [...DESTINATIONS].sort((a, b) => (lastUsed.get(a.id) ?? "").localeCompare(lastUsed.get(b.id) ?? ""))[0];
}
