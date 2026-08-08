#!/usr/bin/env node
/**
 * English Trivia — phrase data generator (GitHub Actions)
 *
 * Generates the phrase data files that feed the question pipeline:
 *   data/colloquialisms.json
 *   data/jargon.json
 *   data/euphemisms.json
 *   data/maxims-aphorisms.json
 *   data/cliches.json
 *
 * Each file is an array of [{"p": "<phrase>", "m": "<meaning>"}, ...].
 * idioms.json + proverbs.json were curated manually and already committed;
 * this script fills the remaining categories using opencode.ai (big-pickle)
 * from GitHub runners (fresh IPs — no rate-limit history, unlike the EC2 IP
 * which opencode.ai has flagged before).
 *
 * STYLE EXAMPLES: existing data files are passed to the model as examples so
 * every category matches the same clean {"p","m"} format and tone.
 * NO REPEATS: recently generated phrases are sent back as a "do not repeat"
 * list, and the merged file is deduped against all existing data files.
 *
 * Strategy per category:
 *   - file missing or short → generate up to TARGET entries in CHUNK-sized
 *     API calls, appending to whatever already exists
 *   - already at/above TARGET → skip (nothing to do)
 *
 * Output: writes data/<category>.json files. The workflow then commits them
 * (via a PR, since main is branch-protected) and reports what changed.
 *
 * Exit codes: 0 = ok (may be "nothing to do"), 1 = failure.
 */

const fs = require("fs");
const path = require("path");

const API_KEY = process.env.OPENCODE_API_KEY;
if (!API_KEY) {
  console.error("OPENCODE_API_KEY not set");
  process.exit(1);
}

const BASE_URL = process.env.OPENCODE_BASE_URL || "https://opencode.ai/zen/v1";
const MODEL = process.env.MODEL || "big-pickle";

const DATA_DIR = path.join(__dirname, "..", "data");
const TARGET = Number(process.env.TARGET || 220); // entries per category
const CHUNK = Number(process.env.CHUNK || 55); // phrases per API call
const MAX_ATTEMPTS = 8; // max API calls per category
const API_TIMEOUT_MS = 240000;

// Categories this script owns (idioms/proverbs already curated).
const CATEGORIES = {
  colloquialisms: {
    label: "Colloquialisms",
    description:
      "everyday informal expressions and slang phrases used in casual conversation (e.g. \"hit the sack\", \"spill the beans\", \"piece of cake\")",
  },
  jargon: {
    label: "Jargon",
    description:
      "specialized words and phrases used by a particular profession or group, and common buzzwords (e.g. \"synergy\", \"bandwidth\", \"touch base\", \"deep dive\")",
  },
  euphemisms: {
    label: "Euphemisms",
    description:
      "mild or indirect words used in place of harsh, blunt, or uncomfortable ones (e.g. \"passed away\", \"between jobs\", \"let go\")",
  },
  "maxims-aphorisms": {
    label: "Maxims & Aphorisms",
    description:
      "short, memorable sayings that state a general truth or rule of conduct (e.g. \"honesty is the best policy\", \"haste makes waste\", \"a penny saved is a penny earned\")",
  },
  cliches: {
    label: "Clichés",
    description:
      "overused phrases and expressions that have lost their freshness but are still widely recognized (e.g. \"at the end of the day\", \"think outside the box\", \"all that glitters is not gold\")",
  },
};

function loadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

function saveJson(file, arr) {
  fs.writeFileSync(file, JSON.stringify(arr, null, 2) + "\n");
}

// All phrases already in the repo (any category) → global dedupe set.
function allKnownPhrases() {
  const known = new Set();
  for (const f of fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".json"))) {
    for (const item of loadJson(path.join(DATA_DIR, f))) {
      if (item && typeof item.p === "string") known.add(item.p.toLowerCase().trim());
    }
  }
  return known;
}

function styleExamples(n = 8) {
  // Pull a few clean examples from existing files as formatting reference.
  const examples = [];
  for (const f of ["idioms.json", "proverbs.json"]) {
    const arr = loadJson(path.join(DATA_DIR, f));
    for (const item of arr) {
      if (item && item.p && item.m) examples.push(item);
      if (examples.length >= n) break;
    }
  }
  return examples
    .map((e) => `{"p": ${JSON.stringify(e.p)}, "m": ${JSON.stringify(e.m)}}`)
    .join("\n");
}

function norm(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

async function generateChunk(category, count, avoidList, attempt) {
  const cat = CATEGORIES[category];
  const avoid =
    avoidList && avoidList.length
      ? "\n\nDo NOT repeat or closely paraphrase any of these already-known phrases:\n" +
        avoidList.map((p) => `- ${p}`).join("\n")
      : "";
  const prompt = `You are compiling a reference list for an English trivia game about ${cat.label}.

TASK: Generate ${count} ${cat.label.toLowerCase()} in English: ${cat.description}.

RULES:
- Real, widely recognized English phrases only. No made-up ones.
- Plain English meanings, 4-12 words each, accurate and concise.
- No duplicates within the list.
- Keep phrases idiomatic and natural — they will appear as trivia questions like "What does the phrase X mean?" or "Which phrase means Y?"
- Avoid phrases that are crude, offensive, or hateful.

STYLE EXAMPLE (exact format to match):
${styleExamples()}

Return ONLY a JSON array (no markdown, no reasoning text) with exactly this structure:
[{"p":"phrase here","m":"plain meaning here"}]${avoid}`;

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        {
          role: "system",
          content: `You are an expert lexicographer compiling a curated list of ${cat.label.toLowerCase()}. Always respond with valid JSON only — no markdown, no extra text.`,
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.9,
      max_tokens: 24000,
    }),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });

  if (res.status === 429) throw new Error(`rate limited (attempt ${attempt})`);
  if (!res.ok) throw new Error(`opencode.ai ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const data = await res.json();
  let content = data?.choices?.[0]?.message?.content || "";
  if (!content.trim()) throw new Error("empty content from model");

  const cleaned = content.replace(/```json\n?/gi, "").replace(/```\n?/g, "").trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error("no JSON array in response");

  const parsed = JSON.parse(cleaned.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error("response is not an array");

  const out = [];
  for (const item of parsed) {
    if (typeof item?.p !== "string" || typeof item?.m !== "string") continue;
    const p = item.p.trim();
    const m = item.m.trim();
    if (!p || !m || p.length > 120 || m.length > 200) continue;
    out.push({ p, m });
  }
  return out;
}

async function fillCategory(category) {
  const cat = CATEGORIES[category];
  const file = path.join(DATA_DIR, category + ".json");
  const existing = loadJson(file);
  const known = allKnownPhrases(); // global dedupe (includes this file's entries)

  const existingPhrases = existing.map((e) => e.p);
  const need = TARGET - existing.length;
  if (need <= 0) {
    console.log(`  ${category}: already ${existing.length} entries (target ${TARGET}) — skipping`);
    return { added: 0, total: existing.length };
  }
  console.log(`  ${category}: ${existing.length} entries → generating ${need} more...`);

  const added = [];
  let attempt = 0;
  let avoid = existingPhrases.concat([...known].slice(-40)); // don't repeat existing

  while (added.length < need && attempt < MAX_ATTEMPTS) {
    attempt += 1;
    let batch = [];
    for (let retry = 0; retry < 3 && !batch.length; retry++) {
      try {
        batch = await generateChunk(category, Math.min(CHUNK, need - added.length), avoid, attempt);
        console.log(`    chunk ${attempt}: ${batch.length} phrases`);
      } catch (err) {
        if (retry === 2) throw err;
        console.log(`    chunk ${attempt} failed (${err.message}) — retry ${retry + 1}/2 in ${20 * (retry + 1)}s`);
        await new Promise((r) => setTimeout(r, 20000 * (retry + 1)));
      }
    }
    if (!batch.length) break;
    const fresh = batch.filter((item) => !known.has(norm(item.p)));
    for (const item of fresh) {
      known.add(norm(item.p));
      avoid.push(item.p);
      added.push(item);
    }
    console.log(`    → ${fresh.length} fresh after dedupe (${added.length}/${need})`);
    // Persist each chunk — partial progress survives failures.
    saveJson(file, existing.concat(added));
    if (fresh.length === 0) break; // model kept repeating known phrases
  }

  saveJson(file, existing.concat(added));
  console.log(`  ${category}: +${added.length} → ${existing.length + added.length} total`);
  return { added: added.length, total: existing.length + added.length };
}

async function main() {
  const only = (process.env.ONLY || "").split(",").map((s) => s.trim()).filter(Boolean);
  const cats = only.length ? only : Object.keys(CATEGORIES);
  let anyAdded = false;
  for (const cat of cats) {
    if (!CATEGORIES[cat]) {
      console.error(`Unknown category: ${cat}`);
      process.exit(1);
    }
    try {
      const r = await fillCategory(cat);
      if (r.added > 0) anyAdded = true;
    } catch (err) {
      console.error(`  ${cat} failed: ${err.message}`);
      // Keep going with other categories; the workflow commit will include
      // whatever succeeded. Final exit code reflects any failures.
      process.exitCode = 1;
    }
  }
  console.log(anyAdded ? "Done — new phrases written." : "Done — nothing to write.");
}

main().catch((err) => {
  console.error(err.stack || String(err));
  process.exit(1);
});
