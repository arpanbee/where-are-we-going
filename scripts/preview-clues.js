#!/usr/bin/env node
// Print Muse-generated clues for a destination, to test prompt quality locally.
//
//   node scripts/preview-clues.js <destination> [--hint "where we got engaged"] [--model muse-spark-1.1]
//
// Key: MUSE_API_KEY from the environment if set, otherwise the
// where-are-we-going/muse-api-key secret via your AWS credentials.
// Calls here don't count against the deployed daily spend cap.

(async () => {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(`--${name}`);
    if (i < 0) return undefined;
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
  };
  const hint = flag("hint");
  const model = flag("model");
  const query = args.join(" ").trim();

  const { DESTINATIONS } = await import("../api/lib/destinations.js");
  const { generateClues, ClueGenerationError } = await import("../api/lib/clues.js");

  if (!query) {
    console.error("Usage: node scripts/preview-clues.js <destination> [--hint text] [--model id]");
    process.exit(2);
  }
  const q = query.toLowerCase();
  const dest =
    DESTINATIONS.find((d) => d.id === q || d.name.toLowerCase() === q) ??
    DESTINATIONS.find((d) => d.name.toLowerCase().startsWith(q));
  if (!dest) {
    const close = DESTINATIONS.filter((d) => d.name.toLowerCase().includes(q) || d.country.toLowerCase().includes(q));
    console.error(`"${query}" isn't on the destination list.${close.length ? ` Did you mean: ${close.map((d) => d.name).join(", ")}?` : ""}`);
    process.exit(1);
  }

  console.log(`${dest.name}, ${dest.country}${hint ? ` (hint: ${hint})` : ""}\n`);
  const started = Date.now();
  try {
    const clues = await generateClues(
      { name: dest.name, country: dest.country, hint },
      { ...(model && { model }), log: (e) => console.error(`  ! attempt ${e.attempt}: ${e.problems?.join("; ") ?? `${e.error}${e.status ? ` ${e.status}` : ""}`}`) },
    );
    clues.forEach((c, i) => console.log(`${i + 1}. ${c}`));
    console.log(`\n(${((Date.now() - started) / 1000).toFixed(1)}s)`);
  } catch (err) {
    if (err instanceof ClueGenerationError) {
      console.error(`Failed: ${err.message}${err.problems.length ? `\n  ${err.problems.join("\n  ")}` : ""}${err.cause ? ` (${err.cause.name}: ${err.cause.message})` : ""}`);
    } else {
      console.error(`Failed: ${err.name}: ${err.message}`);
    }
    process.exit(1);
  }
})();
