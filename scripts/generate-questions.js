#!/usr/bin/env node
/**
 * English Trivia — batch question generator (GitHub Actions)
 *
 * Generates fresh English phrase trivia questions with opencode.ai
 * (big-pickle) and writes them straight into the Firebase Realtime Database
 * bank that the game worker reads. Runs on a schedule (every 30 min) so the
 * game never runs out of questions.
 *
 * SOURCING: every question is based on the curated phrase corpus in this
 * repo (data/*.json — idioms, proverbs, colloquialisms, jargon, euphemisms,
 * maxims & aphorisms, clichés). Each batch samples random phrases from those
 * files and feeds them to the model as the source material. The model is
 * instructed to answer ONLY from the given phrases (+ common knowledge of
 * their standard meanings) and to tag each question with its source phrase.
 *
 * Why not generate in the worker? Same reason as the reference game — the
 * worker's per-request generation gets throttled/truncated and opencode.ai
 * blocks Cloudflare Workers egress (error 1042). Batch generation here:
 *   - uses a big token budget and small chunks → valid JSON every time
 *   - runs from GitHub runners (fresh IPs, no rate-limit history)
 *   - top-ups the shared Firebase bank directly (public-writable RTDB)
 *
 * Bank math: the game clock runs 24/7 at 20s/question → drains ~180
 * questions/hour. This script keeps bankLen − currentSlot ≈ RUNWAY (350),
 * i.e. ~2 hours of runway. Scheduled every 30 min that's plenty of margin.
 *
 * The bank NEVER resets or shrinks (Leon's rule): every question ever
 * generated stays stored forever. Even if the game is badly behind, we just
 * append a big batch — nothing is ever deleted or rebuilt from scratch.
 *
 * Exit codes: 0 = ok (may be "nothing to do"), 1 = failure (workflow alert).
 */

const fs = require("fs");
const path = require("path");

const SLOT_DURATION = 20000; // 20s per question (matches worker)
const RUNWAY = 350; // target: bankLen − slot after a run
const MIN_ADD = 60; // skip unless we'd add at least this many
const CHUNK = 40; // questions per API call (reliable JSON output)
const MAX_TOKENS = 24000; // big budget: reasoning + passage + 40 questions fits
const USED_MAX = 600; // keep this many past questions (matches worker)
const AVOID_N = 40; // how many past questions to send as "do not repeat"
const MAX_ATTEMPTS = 8; // max API calls per run
const API_TIMEOUT_MS = 240000;

const BASE_URL = process.env.OPENCODE_BASE_URL || "https://opencode.ai/zen/v1";
const MODEL = process.env.MODEL || "big-pickle";
// Public-writable RTDB shared by the family of games (pop-party-1 is used by
// trivia-rumble-4 + stickman-rumble; english-trivia gets its own namespace).
const FB_HOST = (process.env.FB_HOST || "pop-party-1-default-rtdb.firebaseio.com").replace(/^https?:\/\//, "");
const P = "english/global"; // RTDB namespace path

const API_KEY = process.env.OPENCODE_API_KEY;
if (!API_KEY) {
  console.error("OPENCODE_API_KEY not set");
  process.exit(1);
}

// ── Phrase corpus (repo data files) ────────────────────────────────────────
const DATA_DIR = path.join(__dirname, "..", "data");

function loadPhrases() {
  const all = [];
  for (const f of fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".json"))) {
    const cat = f.replace(/\.json$/, "");
    try {
      const arr = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf8"));
      for (const item of arr) {
        if (item && typeof item.p === "string" && typeof item.m === "string") {
          all.push({ cat, p: item.p.trim(), m: item.m.trim() });
        }
      }
    } catch (e) {
      console.warn(`  skipping ${f}: ${e.message}`);
    }
  }
  return all;
}

/**
 * Sample `n` phrases (spread across categories) from the corpus.
 */
function samplePhrases(all, n) {
  // Group by category, sample round-robin, shuffle slightly.
  const byCat = {};
  for (const item of all) (byCat[item.cat] ||= []).push(item);
  const cats = Object.keys(byCat);
  const picked = [];
  let i = 0;
  while (picked.length < n && i < n * 3) {
    const cat = cats[i % cats.length];
    const list = byCat[cat];
    if (list.length) {
      const idx = Math.floor(Math.random() * list.length);
      picked.push(list.splice(idx, 1)[0]);
    }
    i += 1;
    if (cats.every((c) => byCat[c].length === 0)) break;
  }
  // Randomize order so consecutive batches aren't grouped by category.
  for (let j = picked.length - 1; j > 0; j--) {
    const k = Math.floor(Math.random() * (j + 1));
    [picked[j], picked[k]] = [picked[k], picked[j]];
  }
  return picked;
}

function phrasesToText(phrases) {
  const lines = phrases.map((ph, i) => `${i + 1}. [${ph.cat}] "${ph.p}" — ${ph.m}`);
  return `SOURCE PHRASES (curated English phrase corpus):\n${lines.join("\n")}`;
}

// ── Firebase helpers ────────────────────────────────────────────────────────
const fbUrl = (path) => `https://${FB_HOST}/${path}.json`;

async function fbGet(path) {
  const res = await fetch(fbUrl(path), { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`fbGet ${path} → ${res.status}`);
  return res.json();
}
async function fbPut(path, data) {
  const res = await fetch(fbUrl(path), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`fbPut ${path} → ${res.status}`);
  return res.json();
}
async function fbPatch(path, data) {
  const res = await fetch(fbUrl(path), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`fbPatch ${path} → ${res.status}`);
  return res.json();
}
async function fbDelete(path) {
  const res = await fetch(fbUrl(path), {
    method: "DELETE",
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`fbDelete ${path} → ${res.status}`);
}

// ── Question generation ─────────────────────────────────────────────────────
function norm(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

async function generateChunk(count, sourceText, avoidTexts, attempt) {
  const avoid =
    avoidTexts && avoidTexts.length
      ? "\n\nHere are recently used questions. Do NOT repeat these or closely paraphrase them — make every question fresh and distinct:\n" +
        avoidTexts.map((t) => `- ${t}`).join("\n")
      : "";
  const prompt = `You are generating questions for an English phrase trivia game. Everything must be based on the phrases in the source list (and the standard, well-known meanings of those phrases).

${sourceText}

Generate ${count} unique trivia questions about English idioms, proverbs, colloquialisms, jargon, euphemisms, maxims & aphorisms, and clichés. Mix:
- "What does the phrase X mean?" (give 4 meanings, one correct)
- "Which phrase means Y?" (give 4 phrases, one correct)
- "Complete the saying: 'A rolling stone ___'" (give 4 completions)
- "Which of these is a well-known [idiom/proverb/cliché]?" (4 phrases, one real)
- Category questions: "What type of phrase is X?" (idiom/proverb/jargon/euphemism/cliché/colloquialism — but ONLY when the type is unambiguous)

Rules:
- Every question must be answerable from standard English usage — no made-up phrases, no trick meanings
- The source list gives the correct meaning for each phrase — trust it
- Vary difficulty from easy to hard
- For every question include a "ref" — the CATEGORY ONLY (e.g. "idiom", "proverb", "colloquialism", "jargon", "euphemism", "maxims-aphorisms", "cliches"). Never include the phrase in ref — it would leak the answer.
- Prefer well-known phrases; use the category label in ref
${avoid}
Return ONLY a JSON array (no markdown, no reasoning text) with exactly this structure:
[{"question":"Question text?","options":["A","B","C","D"],"correctAnswer":0,"ref":"idiom"}]
"correctAnswer" must be the index (0-3) of the correct option. "ref" is a short string.`;

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        {
          role: "system",
          content:
            "You are an English phrase trivia question generator. Generate accurate, engaging trivia questions about idioms, proverbs, colloquialisms, jargon, euphemisms, maxims, aphorisms, and clichés — exactly 4 answer options, one correct answer, each tagged with its source phrase. Always respond with valid JSON only — no markdown, no extra text.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.9,
      max_tokens: MAX_TOKENS,
    }),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });

  if (res.status === 429) throw new Error(`rate limited (attempt ${attempt})`);
  if (!res.ok) throw new Error(`opencode.ai ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const data = await res.json();
  let content = data?.choices?.[0]?.message?.content || "";
  if (!content.trim()) throw new Error("empty content from model");

  // Strip markdown fences if the model was stubborn
  const cleaned = content.replace(/```json\n?/gi, "").replace(/```\n?/g, "").trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error("no JSON array in response");

  const parsed = JSON.parse(cleaned.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error("response is not an array");

  const out = [];
  for (const q of parsed) {
    if (typeof q?.question !== "string" || !Array.isArray(q?.options) || q.options.length !== 4) continue;
    let a = q.correctAnswer;
    if (typeof a === "string") a = parseInt(a, 10);
    if (typeof a !== "number" || a < 0 || a > 3) continue;
    const item = { question: q.question, options: q.options.map(String), correctAnswer: a };
    if (typeof q.ref === "string" && q.ref.trim() && q.ref.length <= 80) item.ref = q.ref.trim();
    out.push(item);
  }
  return out;
}

async function generateFresh(want, usedTexts, onChunk) {
  const all = loadPhrases();
  if (!all.length) throw new Error("no phrase data found in data/ — run generate-phrases first");
  const out = [];
  let attempt = 0;
  while (out.length < want && attempt < MAX_ATTEMPTS) {
    attempt += 1;
    let batch = [];
    // Transient API failures (empty content, 5xx, timeout) → retry with backoff.
    for (let retry = 0; retry < 3 && !batch.length; retry++) {
      try {
        const sample = samplePhrases(all, 70);
        const sourceText = phrasesToText(sample);
        const avoid = usedTexts.slice(0, AVOID_N);
        batch = await generateChunk(Math.min(CHUNK, want - out.length), sourceText, avoid, attempt);
        console.log(`  chunk ${attempt}: ${batch.length} questions (sampled ${sample.length} phrases)`);
      } catch (err) {
        if (retry === 2) throw err;
        console.log(`  chunk ${attempt} failed (${err.message}) — retry ${retry + 1}/2 in ${20 * (retry + 1)}s`);
        await new Promise((r) => setTimeout(r, 20000 * (retry + 1)));
      }
    }
    for (const item of batch) out.push(item);
    // Persist each chunk as it completes — partial progress survives failures.
    if (onChunk) await onChunk(batch);
    if (batch.length === 0) break;
  }
  return out;
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const now = Date.now();

  // Game state (bankLen + slot derived from questionStart) — the worker keeps
  // the authoritative `bankLen`; meta has the generating lock + used list.
  const game = (await fbGet(`${P}/game`)) || {};
  const meta = (await fbGet(`${P}/meta`)) || {};
  const bank = (await fbGet(`${P}/bank`)) || {};
  const bankArr = Array.isArray(bank) ? bank : Object.keys(bank).map((k) => bank[k]).filter(Boolean);
  const bankLen = Number(game.bankLen || bankArr.length || 0);
  const slot = game.questionStart ? Math.floor((now - Number(game.questionStart)) / SLOT_DURATION) : 0;
  const margin = bankLen - slot;
  const used = Array.isArray(meta.used) ? meta.used : [];
  console.log(JSON.stringify({ bankLen, slot, margin, used: used.length, questionStart: game.questionStart, mode: "—" }));

  if (meta.generating && now - Number(meta.generating) < 15 * 60 * 1000) {
    console.log("Another generation is in progress (lock fresh) — skipping.");
    return;
  }

  let bankData;
  const want = Math.max(0, Math.min(RUNWAY - margin, 350));

  if (want < MIN_ADD) {
    console.log(`Bank healthy (margin ${margin}); nothing to add.`);
    await fbPatch(`${P}/meta`, { generating: 0 });
    return;
  }

  // ── APPEND ─────────────────────────────────────────────────────────────
  console.log(`Mode: APPEND — generating up to ${want} questions...`);
  const fresh = await generateFresh(want, used);
  if (fresh.length < MIN_ADD) {
    console.log(`Only ${fresh.length} fresh questions; skipping append.`);
    await fbPatch(`${P}/meta`, { generating: 0 });
    return;
  }

  const existing = bankArr;
  bankData = existing.concat(fresh);

  // Write bank as a JSON object with numeric keys (avoids Firebase array
  // coercion quirks at large sizes; the worker handles both shapes).
  const obj = {};
  for (let i = 0; i < bankData.length; i++) obj[i] = bankData[i];
  await fbPut(`${P}/bank`, obj);

  if (game && game.questionStart) {
    await fbPatch(`${P}/game`, { bankLen: bankData.length });
  } else {
    // First-ever seed: start the question clock too.
    await fbPut(`${P}/game`, {
      bankLen: bankData.length,
      questionStart: now,
      slotDuration: SLOT_DURATION,
      startedAt: now,
    });
  }
  const newUsed = fresh.map((q) => q.question).concat(used).slice(0, USED_MAX);
  await fbPatch(`${P}/meta`, { generating: 0, used: newUsed });
  console.log(`APPEND done: ${fresh.length} added (bank ${bankLen} → ${bankData.length}).`);
}

main().catch((err) => {
  console.error(err.stack || String(err));
  process.exit(1);
});
