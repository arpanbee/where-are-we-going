import { test } from "node:test";
import assert from "node:assert/strict";
import { ClueGenerationError, buildPrompt, generateClues, parseClues, validateClues } from "../lib/clues.js";
import { pickDestination } from "../lib/pick.js";
import { DESTINATIONS } from "../lib/destinations.js";
import { LimitError } from "../lib/errors.js";

const lisbon = { name: "Lisbon", country: "Portugal" };
const good = [
  "Built across seven hills, so pack shoes with grip.",
  "Locals queue for an egg-custard tart dusted with cinnamon.",
  "An old yellow tram is half commute, half ride.",
  "A mournful local music style is on UNESCO's heritage list.",
  "Its red suspension bridge looks a lot like San Francisco's.",
  "It's the westernmost capital in mainland Europe, Lisbon.",
];

test("valid clues pass; clue 6 may name the place", () => {
  assert.deepEqual(validateClues(good, lisbon), []);
});

test("rejects wrong count, empty, too long", () => {
  assert.match(validateClues(good.slice(0, 5), lisbon)[0], /expected 6/);
  assert.match(validateClues([...good.slice(0, 5), "  "], lisbon)[0], /clue 6 is empty/);
  const long = [...good];
  long[2] = "x".repeat(120);
  assert.match(validateClues(long, lisbon)[0], /clue 3 is 120 characters/);
  assert.deepEqual(validateClues(null, lisbon), ["reply was not a JSON array"]);
});

test("rejects name or country in clues 1-5, case and accent insensitive", () => {
  const c = [...good];
  c[0] = "Pack light for PORTUGAL in summer";
  c[4] = "Close to lisbon's airport";
  assert.deepEqual(validateClues(c, lisbon), ['clue 1 names "Portugal"', 'clue 5 names "Lisbon"']);
  const cancun = { name: "Cancún", country: "Mexico" };
  assert.deepEqual(validateClues(["Fly into CANCUN airport", ...good.slice(1)], cancun), ['clue 1 names "Cancún"']);
  // "Mexican" doesn't start with "mexico": allowed by the validator (the prompt asks the model to avoid it).
  assert.deepEqual(validateClues(["Mexican food", ...good.slice(1)], cancun), []);
});

test("multi-country entries and word-start matching", () => {
  const vf = { name: "Victoria Falls", country: "Zambia / Zimbabwe" };
  assert.ok(validateClues(["Bordering Zimbabwe", ...good.slice(1)], vf).includes('clue 1 names "Zimbabwe"'));
  const uk = { name: "Edinburgh", country: "UK" };
  assert.deepEqual(validateClues(["A duke once lived here", ...good.slice(1)], uk), []);
  assert.ok(validateClues(["Peruvian food", ...good.slice(1)], { name: "Machu Picchu", country: "Peru" }).includes('clue 1 names "Peru"'));
});

test("parseClues handles fences, wrapper objects and prose", () => {
  assert.deepEqual(parseClues('```json\n["a","b"]\n```'), ["a", "b"]);
  assert.deepEqual(parseClues('{"clues":["a"]}'), ["a"]);
  assert.deepEqual(parseClues('Here you go: ["a","b"] enjoy'), ["a", "b"]);
  assert.equal(parseClues("no json"), null);
});

test("prompt includes hint only when given", () => {
  assert.ok(!buildPrompt(lisbon).includes("Hint:"));
  assert.ok(buildPrompt({ ...lisbon, hint: "first trip" }).includes('Hint: "first trip"'));
  assert.ok(buildPrompt(lisbon).includes("JSON array of 6 strings"));
});

const reply = (content, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }] }),
});
const quiet = { apiKey: "test-key", log: () => {} };

test("generateClues returns trimmed clues on first valid reply", async () => {
  let calls = 0;
  const out = await generateClues(lisbon, { ...quiet, fetchImpl: async () => (calls++, reply(good.map((c) => ` ${c} `))) });
  assert.deepEqual(out, good);
  assert.equal(calls, 1);
});

test("retries once with feedback, counting both calls", async () => {
  const bodies = [];
  let guarded = 0;
  const bad = [...good];
  bad[0] = "Lisbon is lovely";
  const replies = [reply(bad), reply(good)];
  const out = await generateClues(lisbon, {
    ...quiet,
    beforeCall: async () => void guarded++,
    fetchImpl: async (_url, init) => (bodies.push(JSON.parse(init.body)), replies.shift()),
  });
  assert.deepEqual(out, good);
  assert.equal(guarded, 2);
  assert.match(bodies[1].messages[1].content, /previous reply had these problems, fix them: clue 1 names "Lisbon"/);
  assert.equal(bodies[0].model, "muse-spark-1.1");
});

test("throws ClueGenerationError after two invalid replies", async () => {
  let calls = 0;
  await assert.rejects(
    generateClues(lisbon, { ...quiet, fetchImpl: async () => (calls++, reply(["too few"])) }),
    (err) => err instanceof ClueGenerationError && /expected 6/.test(err.problems[0]),
  );
  assert.equal(calls, 2);
});

test("does not retry auth errors; does retry 5xx", async () => {
  let calls = 0;
  await assert.rejects(generateClues(lisbon, { ...quiet, fetchImpl: async () => (calls++, reply(null, 401)) }), ClueGenerationError);
  assert.equal(calls, 1);
  calls = 0;
  const replies = [reply(null, 503), reply(good)];
  assert.deepEqual(await generateClues(lisbon, { ...quiet, fetchImpl: async () => (calls++, replies.shift()) }), good);
  assert.equal(calls, 2);
});

test("spend guard errors propagate before any HTTP call", async () => {
  let calls = 0;
  await assert.rejects(
    generateClues(lisbon, { ...quiet, beforeCall: async () => { throw new LimitError("cap"); }, fetchImpl: async () => (calls++, reply(good)) }),
    LimitError,
  );
  assert.equal(calls, 0);
});

test("skips the retry when the deadline is too close", async () => {
  let calls = 0;
  await assert.rejects(
    generateClues(lisbon, { ...quiet, deadline: Date.now() + 2_000, fetchImpl: async () => (calls++, reply(["x"])) }),
    ClueGenerationError,
  );
  assert.equal(calls, 1);
});

test("passes a 20s timeout signal", async () => {
  let signal;
  await generateClues(lisbon, { ...quiet, fetchImpl: async (_u, init) => ((signal = init.signal), reply(good)) });
  assert.ok(signal instanceof AbortSignal);
});

test("pickDestination avoids recently used, falls back to least recent", () => {
  const used = new Map([["paris", "2026-11-01"], ["rome", "2026-01-01"]]);
  for (let i = 0; i < 200; i++) assert.notEqual(pickDestination(used, "2026-09-01").id, "paris");
  const allRecent = new Map(DESTINATIONS.map((d) => [d.id, "2026-11-10"]));
  allRecent.set("kyoto", "2026-10-01");
  assert.equal(pickDestination(allRecent, "2026-09-01").id, "kyoto");
});
