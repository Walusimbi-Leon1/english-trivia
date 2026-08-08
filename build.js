#!/usr/bin/env node
/**
 * English Trivia — build script
 * Inlines all client assets (src/* + vendored Discord SDK) into
 * dist/worker.js as a STATIC map, ready for Cloudflare Workers deploy.
 * Also builds the built-in fallback question bank deterministically from
 * the committed phrase corpus (data/*.json) — no AI needed for the seed.
 *
 * Usage: node build.js   → writes dist/worker.js
 */
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const SRC = path.join(ROOT, "src");
const DATA = path.join(ROOT, "data");
const DIST = path.join(ROOT, "dist");

const FILES = {
  "index.html": "index.html",
  "style.css": "style.css",
  "discord.js": "discord.js",
  "firebase.js": "firebase.js",
  "app.js": "app.js",
  "support.js": "support.js",
  "vendor/discord-sdk.mjs": "vendor/discord-sdk.mjs",
  "privacy.html": "privacy.html",
  "terms.html": "terms.html",
};

function read(name) {
  return fs.readFileSync(path.join(SRC, name), "utf8");
}

// ── Fallback bank from phrase corpus ────────────────────────────────────────
// For every phrase {"p","m"} emit a "What does the phrase X mean?" question
// with 3 random other meanings as distractors. Deterministic output: seed the
// RNG with a fixed value so every build produces the same bank.
function buildFallbackBank() {
  const entries = [];
  const seen = new Set();
  for (const f of fs.readdirSync(DATA).filter((f) => f.endsWith(".json")).sort()) {
    const cat = f.replace(/\.json$/, "");
    let arr = [];
    try {
      arr = JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8"));
    } catch (e) {
      console.error(`  fallback: skipping ${f} (${e.message})`);
      continue;
    }
    for (const item of arr) {
      if (item && typeof item.p === "string" && item.p.trim() && typeof item.m === "string" && item.m.trim()) {
        const key = item.p.trim().toLowerCase();
        if (seen.has(key)) continue; // same phrase in multiple categories
        seen.add(key);
        entries.push({ cat, p: item.p.trim(), m: item.m.trim() });
      }
    }
  }
  if (!entries.length) throw new Error("no phrase data found — cannot build fallback bank");

  // Deterministic PRNG (mulberry32) so builds are reproducible.
  let seed = 0x2f6e2b1;
  const rnd = () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const shuffle = (a) => {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  const bank = [];
  for (const e of entries) {
    // 3 distinct distractor meanings (not this phrase's meaning).
    const distractors = shuffle(
      entries.filter((x) => x.m !== e.m && x.p !== e.p).map((x) => x.m)
    ).slice(0, 3);
    if (distractors.length < 3) continue;
    const options = shuffle([e.m, ...distractors]);
    const correct = options.indexOf(e.m);
    bank.push({
      q: `What does the phrase “${e.p}” mean?`,
      o: options,
      a: correct,
      ref: e.cat, // category only — never the phrase (it's the answer)
    });
  }
  console.log(`Fallback bank: ${bank.length} questions from ${entries.length} phrases (${fs.readdirSync(DATA).filter((f) => f.endsWith(".json")).length} files)`);
  return bank;
}

const fallbackBank = buildFallbackBank();

let worker = fs.readFileSync(path.join(ROOT, "worker.js"), "utf8");

for (const [key, file] of Object.entries(FILES)) {
  const placeholder = `__${key.toUpperCase().replace(/[^A-Z0-9]/g, "_")}__`;
  const content = read(file);
  if (!worker.includes(placeholder)) {
    console.error(`Missing placeholder ${placeholder} in worker.js`);
    process.exit(1);
  }
  // JSON.stringify gives us a safe JS string literal for every file.
  worker = worker.replace(placeholder, () => JSON.stringify(content));
}

// Fallback bank placeholder — inject as a JS array literal.
if (!worker.includes("__FALLBACK_BANK__")) {
  console.error("Missing placeholder __FALLBACK_BANK__ in worker.js");
  process.exit(1);
}
worker = worker.replace(/__FALLBACK_BANK__/g, () => JSON.stringify(fallbackBank));

// Any leftover placeholders?
const leftovers = worker.match(/__[A-Z0-9_]+__/g) || [];
if (leftovers.length) {
  console.error("Unresolved placeholders:", leftovers);
  process.exit(1);
}

fs.mkdirSync(DIST, { recursive: true });
fs.writeFileSync(path.join(DIST, "worker.js"), worker);
const kb = (worker.length / 1024).toFixed(1);
console.log(`Built dist/worker.js (${kb} KB)`);
