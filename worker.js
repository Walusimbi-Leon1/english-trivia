/**
 * English Trivia — Cloudflare Worker
 *
 * Serves the whole game: static assets, Discord OAuth exchange,
 * question generation (opencode.ai / big-pickle), Firebase proxies.
 *
 * Game model (single GLOBAL room, time-sliced — see README):
 *  - english/global/game    = { questionStart, slotDuration, bankLen, startedAt }
 *  - english/global/bank/<i> = { question, options, correctAnswer, ref? }
 *  - english/global/players/<uid> = { id, username, avatarUrl, score, lastSeen, online }  (persistent)
 *  - english/global/answers/<slot>/<uid> = { answer, at }   (per-question answers)
 *  - english/global/meta    = { generating: <ts>, used: [...] }  (bank lock + no-repeat list)
 *
 * All clients compute the current question deterministically:
 *   slot = floor((now - questionStart) / slotDuration)
 *   question = bank[slot % bank.length]
 *
 * Question sourcing: the GitHub Actions pipeline (scripts/generate-questions.js)
 * generates fresh English phrase questions from the repo's data/*.json corpus
 * every 30 minutes. The worker's own AI generation is a fallback for when the
 * bank is empty (note: opencode.ai blocks Cloudflare Workers egress — error
 * 1042 — so the worker usually falls back to the built-in phrase bank below,
 * built deterministically from the committed data files, which also serves as
 * the instant seed).
 */

const FB_DEFAULT_HOST = "pop-party-1-default-rtdb.firebaseio.com";
const SLOT_DURATION = 20000;   // 20 seconds per question
const BANK_BATCH = 20;         // questions generated per top-up
const BANK_MAX = 1000;         // reset bank above this size (raised: batch top-ups from GitHub Actions)
const TOP_UP_THRESHOLD = 20;   // top up when fewer than this many questions remain
const GEN_LOCK_MS = 45000;     // lock window for concurrent top-ups
const USED_MAX = 600;          // keep this many past questions in meta.used (FIFO)
const AVOID_PROMPT_N = 60;     // how many past questions to send to the AI as "do not repeat"

const P = "english/global";    // RTDB namespace path

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" },
  });
}

// ── Support page (proxied so it opens INSIDE the Discord activity) ─────────
// Discord's Activity sandbox blocks external windows/navigation, so a plain
// target="_blank" link does nothing inside the game. Serving the support
// page same-origin (like /privacy + /terms) makes it open in-window. The
// voice-support page is self-contained (inline CSS, Paystack inline.js only),
// so proxying just the HTML is enough; we inject a back-to-game bar on top.
const SUPPORT_URL = "https://walusimbi-leon1.github.io/voice-support/";
async function handleSupport() {
  // Keep /support working for any cached links: bounce to the real
  // donate page. In Discord the game JS intercepts and uses
  // openExternalLink instead; in a browser this redirect is fine.
  return Response.redirect(SUPPORT_URL, 302);
}

function notFound() {
  return new Response("Not found", { status: 404 });
}

// ── Firebase direct helpers (server side) ───────────────────────────────────
function fbUrl(env, path) {
  const host = (env.FB_HOST || FB_DEFAULT_HOST).replace(/^https?:\/\//, "");
  return `https://${host}/${path}.json`;
}

async function fbGet(env, path) {
  const res = await fetch(fbUrl(env, path));
  if (!res.ok) throw new Error(`fbGet ${path} → ${res.status}`);
  return res.json();
}

async function fbPut(env, path, data) {
  const res = await fetch(fbUrl(env, path), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`fbPut ${path} → ${res.status}`);
  return res.json();
}

async function fbPatch(env, path, data) {
  const res = await fetch(fbUrl(env, path), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`fbPatch ${path} → ${res.status}`);
  return res.json();
}

async function fbDelete(env, path) {
  const res = await fetch(fbUrl(env, path), { method: "DELETE" });
  if (!res.ok) throw new Error(`fbDelete ${path} → ${res.status}`);
  return res.json();
}

function bankCount(bank) {
  return bank && typeof bank === "object" ? Object.keys(bank).length : 0;
}

// Normalize a question for duplicate comparison (case/space/punct-insensitive).
function norm(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ── "No repeats" bookkeeping ────────────────────────────────────────────────
async function readUsed(env) {
  const meta = (await fbGet(env, `${P}/meta`).catch(() => null)) || {};
  return Array.isArray(meta.used) ? meta.used : [];
}

async function markUsed(env, questions) {
  if (!questions || !questions.length) return;
  const meta = (await fbGet(env, `${P}/meta`).catch(() => null)) || {};
  const used = Array.isArray(meta.used) ? meta.used : [];
  for (const q of questions) {
    if (q?.question) used.push(q.question);
  }
  const trimmed = used.slice(-USED_MAX);
  await fbPatch(env, `${P}/meta`, { used: trimmed }).catch(() => {});
}

function filterFresh(questions, usedSet, bankSet) {
  const out = [];
  const seen = new Set();
  for (const q of questions) {
    if (!q?.question) continue;
    const n = norm(q.question);
    if (!n) continue;
    if (usedSet.has(n) || bankSet.has(n) || seen.has(n)) continue;
    seen.add(n);
    out.push(q);
  }
  return out;
}

// ── Discord OAuth exchange (Arrow Blast pattern) ────────────────────────────
async function handleExchange(request, env) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  let code;
  try {
    const body = await request.json();
    code = body && body.code;
  } catch {
    return json({ error: "Bad request — code required" }, 400);
  }
  if (!code || typeof code !== "string") return json({ error: "Bad request — code required" }, 400);

  const clientId = env.DISCORD_CLIENT_ID;
  const clientSecret = env.DISCORD_CLIENT_SECRET;
  const redirectUri = env.REDIRECT_URI;

  if (!clientId || !clientSecret) {
    return json({ error: "Server configuration error — DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET not set" }, 500);
  }

  try {
    const resp = await fetch("https://discord.com/api/v10/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      return json({ error: data.error, description: data.error_description }, resp.status);
    }
    return json({ access_token: data.access_token });
  } catch (err) {
    console.error("[Exchange] Internal error:", err.message);
    return json({ error: "Internal server error" }, 500);
  }
}

// ── Question generation via opencode.ai (big-pickle) ────────────────────────
async function generateWithOpenCode(prompt, env) {
  const apiKey = env.OPENCODE_API_KEY;
  if (!apiKey) throw new Error("OPENCODE_API_KEY not set");
  const model = env.MODEL || "big-pickle";
  const response = await fetch("https://opencode.ai/zen/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content:
            "You are a Quran trivia question generator. Generate accurate, engaging Quran trivia questions with exactly 4 answer options and one correct answer, each tagged with its Quran reference (surah:ayah). Always respond with valid JSON only — no markdown, no extra text.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.9,
      max_tokens: 16384, // big-pickle is a reasoning model — 4096 was too small, JSON got truncated
    }),
  });
  if (!response.ok) throw new Error(`opencode.ai ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("opencode.ai empty response");
  return content;
}

function parseQuestions(raw, count) {
  const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error("No JSON array in response");
  const parsed = JSON.parse(cleaned.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error("Response is not an array");
  const out = [];
  for (const q of parsed) {
    if (typeof q?.question !== "string" || !Array.isArray(q?.options) || q.options.length !== 4) continue;
    let a = q.correctAnswer;
    if (typeof a === "string") a = parseInt(a, 10);
    if (typeof a !== "number" || a < 0 || a > 3) continue;
    const item = { question: q.question, options: q.options.map(String), correctAnswer: a };
    if (typeof q.ref === "string" && q.ref.trim() && q.ref.length <= 80) item.ref = q.ref.trim();
    out.push(item);
    if (out.length >= count) break;
  }
  if (!out.length) throw new Error("No valid questions parsed");
  return out;
}

async function generateQuestions(count, env, avoidTexts) {
  const avoid =
    avoidTexts && avoidTexts.length
      ? "\n\nHere are recently used questions. Do NOT repeat these or closely paraphrase them — make every question fresh and distinct:\n" +
        avoidTexts
          .slice(-AVOID_PROMPT_N)
          .map((t) => `- ${t}`)
          .join("\n")
      : "";
  const prompt = `Generate ${count} unique English phrase trivia questions. All questions must be about English idioms, proverbs, colloquialisms, jargon, euphemisms, maxims & aphorisms, and clichés — their meanings, origins, usage, and completion. Mix:
- "What does the phrase X mean?" (4 meanings, one correct)
- "Which phrase means Y?" (4 phrases, one correct)
- "Complete the saying: 'A rolling stone ___'" (4 completions)
- "Which of these is a well-known [idiom/proverb/cliché]?" (4 phrases, one real)
- Category questions ("What type of phrase is X?") only when unambiguous
Vary the difficulty. Every question must have exactly one correct answer based on standard English usage.${avoid}
For every question include a "ref" — the CATEGORY ONLY (e.g. "idiom", "proverb", "colloquialism", "jargon", "euphemism", "maxims-aphorisms", "cliches"). Never include the phrase itself in ref — it would leak the answer.
Return ONLY a JSON array (no markdown) with exactly this structure:
[{"question":"Question text?","options":["A","B","C","D"],"correctAnswer":0,"ref":"idiom"}]
"correctAnswer" must be the index (0-3) of the correct option.`;
  const raw = await generateWithOpenCode(prompt, env);
  return parseQuestions(raw, count);
}

// ── Built-in phrase bank (instant seed + fallback) ───────────────────────────
// Built deterministically at build time from the committed phrase corpus in
// data/*.json (no AI involved): for each phrase we emit a "What does the
// phrase X mean?" question with 3 random other meanings as distractors.
// build.js fills __FALLBACK_BANK__.
const QUESTION_BANK = __FALLBACK_BANK__;

// ── Answer-letter randomization ─────────────────────────────────────────────
// The AI generator and the static bank both bias heavily toward one
// correctAnswer index, so players could win by always tapping the same
// letter. Fix: whenever questions enter the bank, shuffle their options so the
// correct answer lands on a random letter — and never the same letter as the
// previous question in slot order (wrap-around at the bank seam included).
// Shuffling happens SERVER-side at write time so every client computes the
// same letters for the same slot (a client-side shuffle would break scoring).
function reshuffle(q, forbidden) {
  if (!q || !Array.isArray(q.options) || q.options.length < 2) return q;
  const options = q.options.slice();
  const n = options.length;
  const ci = Number.isInteger(q.correctAnswer) && q.correctAnswer >= 0 && q.correctAnswer < n ? q.correctAnswer : 0;
  const correct = options[ci];
  let candidates = [];
  for (let i = 0; i < n; i++) if (!forbidden.has(i)) candidates.push(i);
  if (!candidates.length) candidates = Array.from({ length: n }, (_, i) => i);
  const target = candidates[Math.floor(Math.random() * candidates.length)];
  const others = options.filter((_, i) => i !== ci);
  for (let i = others.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [others[i], others[j]] = [others[j], others[i]];
  }
  const out = new Array(n);
  out[target] = correct;
  let k = 0;
  for (let i = 0; i < n; i++) {
    if (i === target) continue;
    out[i] = others[k++];
  }
  return { question: q.question, options: out, correctAnswer: target };
}

// Normalize a full ordered bank: random letter for every question, no two
// consecutive entries share a correct letter, and the last entry differs from
// the first (bank seam / wrap-around). Always satisfiable (4 options, at most
// 2 forbidden letters for any single question).
function normalizeBank(arr) {
  if (!Array.isArray(arr) || !arr.length) return arr;
  const out = arr.map((q) => ({ ...q, options: Array.isArray(q.options) ? q.options.slice() : q.options }));
  out[0] = reshuffle(out[0], new Set());
  for (let i = 1; i < out.length; i++) {
    out[i] = reshuffle(out[i], new Set([out[i - 1].correctAnswer]));
  }
  const n = out.length;
  if (n > 1 && out[n - 1].correctAnswer === out[0].correctAnswer) {
    out[n - 1] = reshuffle(out[n - 1], new Set([out[n - 2].correctAnswer, out[0].correctAnswer]));
  }
  return out;
}

function builtinSeed(excludeSet) {
  const all = [];
  for (const item of QUESTION_BANK) {
    if (excludeSet && excludeSet.has(norm(item.q))) continue;
    all.push({ question: item.q, options: item.o, correctAnswer: item.a, ref: item.ref });
  }
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all;
}

function pickQuestions(count, usedRaw) {
  const exclude = usedRaw && usedRaw.length ? new Set(usedRaw.map(norm)) : null;
  const all = builtinSeed(exclude);
  return all.slice(0, Math.min(count, all.length));
}

// ── /api/trivia — ensure the bank has questions ─────────────────────────────
async function handleTrivia(request, env, ctx) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const body = await request.json().catch(() => ({}));
  const count = Math.max(5, Math.min(30, Number(body.count) || BANK_BATCH));

  try {
    const meta = (await fbGet(env, `${P}/meta`).catch(() => null)) || {};
    const bank = (await fbGet(env, `${P}/bank`).catch(() => null)) || {};
    const len = bankCount(bank);
    const usedRaw = Array.isArray(meta.used) ? meta.used : [];
    const usedSet = new Set(usedRaw.map(norm));
    const bankSet = new Set(Object.values(bank).filter((q) => q?.question).map((q) => norm(q.question)));

    if (meta.generating && Date.now() - meta.generating < GEN_LOCK_MS) {
      return json({ bankLen: len, generating: true });
    }

    // One-time migration (lettersV2): reshuffle the EXISTING bank so the
    // correct answer lands on a random letter per question and never repeats
    // the previous question's letter. Restart the clock so the live slot
    // re-syncs cleanly (player scores persist; only the current question
    // restarts). Self-heals on the first client request after deploy.
    // NOTE: the flag lives at ${P}/lettersV2 (its own path) — meta is
    // full-replaced by the top-up paths, so a flag there would be clobbered
    // and the migration would re-run (and restart the clock) every top-up.
    const lettersV2 = await fbGet(env, `${P}/lettersV2`).catch(() => null);
    if (!lettersV2 && len > 0) {
      if (meta.lastReset && Date.now() - meta.lastReset < 15000) {
        return json({ bankLen: len, reset: false, recently: true });
      }
      const arr = normalizeBank(
        Object.keys(bank)
          .map(Number)
          .sort((a, b) => a - b)
          .map((k) => bank[k])
      );
      const patch = {};
      arr.forEach((q, i) => (patch[i] = q));
      await fbPut(env, `${P}/bank`, patch);
      await fbDelete(env, `${P}/answers`).catch(() => {});
      await fbPut(env, `${P}/game`, {
        questionStart: Date.now(),
        slotDuration: SLOT_DURATION,
        bankLen: arr.length,
        startedAt: Date.now(),
      });
      await fbPut(env, `${P}/lettersV2`, { v: 1, at: Date.now() });
      await fbPut(env, `${P}/meta`, { ...meta, generating: 0, lettersV2: 1, lastReset: Date.now(), used: usedRaw });
      return json({ bankLen: arr.length, reset: true, lettersV2: true });
    }

    // Empty bank → generate a fresh AI batch immediately (fallback: built-ins),
    // then start the question clock.
    if (len === 0) {
      await fbPut(env, `${P}/meta`, { generating: Date.now(), used: usedRaw });
      let questions;
      try {
        questions = await generateQuestions(count, env, usedRaw);
      } catch (err) {
        console.error("[Trivia] opencode.ai failed, using built-in:", err.message);
        questions = null;
      }
      if (!questions || !questions.length) questions = pickQuestions(count, usedRaw);
      let fresh = filterFresh(questions, usedSet, bankSet);
      if (!fresh.length) fresh = questions;
      if (!fresh.length) fresh = builtinSeed();   // absolute last resort — never stall
      fresh = normalizeBank(fresh);
      const patch = {};
      fresh.forEach((q, i) => (patch[i] = q));
      await fbPut(env, `${P}/bank`, patch);
      const game = await fbGet(env, `${P}/game`).catch(() => null);
      await fbPut(env, `${P}/game`, {
        questionStart: Date.now(),
        slotDuration: SLOT_DURATION,
        bankLen: fresh.length,
        startedAt: game?.startedAt || Date.now(),
      });
      await markUsed(env, fresh);
      ctxWait(ctx, env, count, usedRaw);
      return json({ bankLen: fresh.length, source: fresh.length ? "ai" : "seed" });
    }

    // Bank healthy — nothing to do (the client only calls when the bank
    // runs low, but guard against redundant generation anyway).
    const game0 = (await fbGet(env, `${P}/game`).catch(() => null)) || {};
    const globalSlot = game0.questionStart ? Math.floor((Date.now() - game0.questionStart) / SLOT_DURATION) : 0;
    if (globalSlot - len + TOP_UP_THRESHOLD <= 0) {
      return json({ bankLen: len, healthy: true });
    }

    // Bank low → generate fresh batches via opencode.ai (avoiding repeats).
    await fbPut(env, `${P}/meta`, { generating: Date.now(), used: usedRaw });
    const need = Math.max(count, Math.min(60, globalSlot - len + TOP_UP_THRESHOLD));

    const allAccepted = [];
    let fromStatic = false;
    for (let round = 0; round < 3 && allAccepted.length < need; round++) {
      const want = Math.min(BANK_BATCH, need - allAccepted.length);
      let batch;
      try {
        batch = await generateQuestions(want, env, usedRaw);
      } catch (err) {
        console.error("[Trivia] opencode.ai failed, using built-in:", err.message);
        batch = null;
      }
      if (!batch || !batch.length) {
        batch = pickQuestions(want, usedRaw);
        fromStatic = true;
      }
      let fresh = filterFresh(batch, usedSet, bankSet);
      if (!fresh.length) fresh = batch;
      if (!fresh.length) break;
      // Chain correct-letter positions against the previous bank entry so no
      // two consecutive questions share a correct letter.
      let prevCorrect = null;
      {
        const keys = Object.keys(bank).map(Number).sort((a, b) => a - b);
        const last = bank[keys[keys.length - 1]];
        if (last && last.correctAnswer != null) prevCorrect = last.correctAnswer;
      }
      fresh = fresh.map((q) => {
        const r = reshuffle(q, prevCorrect == null ? new Set() : new Set([prevCorrect]));
        prevCorrect = r.correctAnswer;
        return r;
      });
      const patch = {};
      fresh.forEach((q, i) => (patch[len + allAccepted.length + i] = q));
      await fbPatch(env, `${P}/bank`, patch);
      fresh.forEach((q) => q?.question && bankSet.add(norm(q.question)));
      allAccepted.push(...fresh);
    }
    if (!allAccepted.length) {
      await fbPut(env, `${P}/meta`, { generating: 0, used: usedRaw });
      return json({ bankLen: len, skipped: true });
    }
    await markUsed(env, allAccepted);
    const bankLen = len + allAccepted.length;

    // NOTE: no BANK_MAX reset here on purpose — resetting the bank would
    // require resetting questionStart, which resets the question counter
    // (bible-trivia keeps its counter climbing with a bank far above 1000;
    // Firebase handles it fine). The GitHub Actions pipeline appends and
    // prunes instead.

    const game = await fbGet(env, `${P}/game`).catch(() => null);
    if (game) {
      await fbPatch(env, `${P}/game`, { bankLen });
    } else {
      await fbPut(env, `${P}/game`, {
        questionStart: Date.now(),
        slotDuration: SLOT_DURATION,
        bankLen,
        startedAt: Date.now(),
      });
    }
    await fbPut(env, `${P}/meta`, { generating: 0, used: (await readUsed(env)) });
    return json({ bankLen, source: fromStatic ? "bank" : "ai" });
  } catch (err) {
    console.error("[Trivia] error:", err.message);
    await fbPut(env, `${P}/meta`, { generating: 0 }).catch(() => {});
    return json({ error: err.message }, 500);
  }
}

function ctxWait(ctx, env, count, usedRaw) {
  ctx?.waitUntil?.(
    (async () => {
      try {
        const used = (await readUsed(env)).slice();
        const usedSet = new Set(used.map(norm));
        const bank = (await fbGet(env, `${P}/bank`).catch(() => null)) || {};
        const len = bankCount(bank);
        const bankSet = new Set(Object.values(bank).filter((q) => q?.question).map((q) => norm(q.question)));
        let questions;
        try {
          questions = await generateQuestions(count, env, used);
        } catch (err) {
          console.error("[Trivia] bg opencode.ai failed:", err.message);
          await fbPut(env, `${P}/meta`, { generating: 0, lastError: err.message }).catch(() => {});
          return;
        }
        const fresh = filterFresh(questions, usedSet, bankSet);
        if (!fresh.length) {
          await fbPut(env, `${P}/meta`, { generating: 0 }).catch(() => {});
          return;
        }
        // Re-read the bank tail right before appending: another request may
        // have reshuffled/reset the bank while we were generating, so the
        // stale `len` offset could overwrite live questions.
        const tailBank = (await fbGet(env, `${P}/bank`).catch(() => null)) || {};
        const tailKeys = Object.keys(tailBank).map(Number).sort((a, b) => a - b);
        const startKey = tailKeys.length ? tailKeys[tailKeys.length - 1] + 1 : 0;
        const lastQ = tailBank[tailKeys[tailKeys.length - 1]];
        let prevCorrect = lastQ && lastQ.correctAnswer != null ? lastQ.correctAnswer : null;
        const patch = {};
        fresh.forEach((q, i) => {
          const r = reshuffle(q, prevCorrect == null ? new Set() : new Set([prevCorrect]));
          prevCorrect = r.correctAnswer;
          patch[startKey + i] = r;
        });
        await fbPatch(env, `${P}/bank`, patch);
        const game = await fbGet(env, `${P}/game`).catch(() => null);
        if (game) await fbPatch(env, `${P}/game`, { bankLen: startKey + fresh.length });
        await markUsed(env, fresh);
        await fbPut(env, `${P}/meta`, { generating: 0, used: (await readUsed(env)) }).catch(() => {});
        console.log("[Trivia] bg top-up appended", fresh.length);
      } catch (err) {
        console.error("[Trivia] bg top-up error:", err.message);
        await fbPut(env, `${P}/meta`, { generating: 0, lastError: err.message }).catch(() => {});
      }
    })()
  );
}

// ── /api/time — clock sync for question timing ──────────────────────────────
async function handleTime(request, env) {
  const game = await fbGet(env, `${P}/game`).catch(() => null);
  return json({ now: Date.now(), game: game || null });
}

// ── Firebase proxies (Dice Arena pattern) ───────────────────────────────────
function upstreamUrl(env, pathAfter, search) {
  const host = (env.FB_HOST || FB_DEFAULT_HOST).replace(/^https?:\/\//, "");
  const u = new URL(`https://${host}${pathAfter}`);
  u.search = search;
  return u;
}

async function restProxy(request, env, url) {
  const pathAfter = url.pathname.replace(/^\/firebase/, "");
  const target = upstreamUrl(env, pathAfter, url.search);
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("connection");
  headers.delete("cf-connecting-ip");
  headers.set("origin", url.origin);
  const method = headers.get("x-fb-method") || request.method;
  headers.delete("x-fb-method");
  const init = { method, headers, redirect: "follow" };
  if (method !== "GET" && method !== "HEAD") {
    init.body = request.body;
  }
  const res = await fetch(target, init);
  if (!url.pathname.startsWith("/firebase/english/global/meta/logs")) {
    logRequest(env, method, url.pathname, res.status);
  }
  const outHeaders = new Headers(res.headers);
  outHeaders.set("Cache-Control", "no-store");
  outHeaders.set("Access-Control-Allow-Origin", url.origin);
  return new Response(res.body, { status: res.status, headers: outHeaders });
}

async function sseProxy(request, env, url) {
  const pathAfter = url.pathname.replace(/^\/firebase\/stream/, "");
  const target = upstreamUrl(env, pathAfter, url.search);
  const upstream = await fetch(target, { headers: { Accept: "text/event-stream" } });
  if (!upstream.ok || !upstream.body) {
    return json({ error: `upstream ${upstream.status}` }, upstream.status);
  }
  const headers = new Headers();
  headers.set("Content-Type", "text/event-stream");
  headers.set("Cache-Control", "no-cache, no-transform");
  headers.set("X-Accel-Buffering", "no");
  headers.set("Access-Control-Allow-Origin", url.origin);
  return new Response(upstream.body, { status: 200, headers });
}

let logBuffer = [];
let logFlushing = false;
function logRequest(env, method, path, status) {
  logBuffer.push({ m: method, p: path.slice(0, 60), s: status, t: Date.now() });
  if (logBuffer.length > 30) logBuffer.shift();
  if (logFlushing) return;
  logFlushing = true;
  ctxWaitSafe(env, () => {
    try {
      return fbPut(env, `${P}/meta/logs`, logBuffer.slice(-25));
    } finally {
      logFlushing = false;
    }
  });
}
function ctxWaitSafe(env, fn) {
  fn().catch(() => {});
}

// ── Static assets (inlined at build time by build.js) ───────────────────────
// Each value is replaced by a JSON string literal of the file contents.
// NOTE: do not wrap these in backticks — the files contain backticks of
// their own (template literals), which would break the outer literal.
const STATIC = {
  "index.html": __INDEX_HTML__,
  "style.css": __STYLE_CSS__,
  "discord.js": __DISCORD_JS__,
  "firebase.js": __FIREBASE_JS__,
  "app.js": __APP_JS__,
  "support.js": __SUPPORT_JS__,
  "vendor/discord-sdk.mjs": __VENDOR_DISCORD_SDK_MJS__,
  "privacy.html": __PRIVACY_HTML__,
  "terms.html": __TERMS_HTML__,
};

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path.startsWith("/firebase/stream/")) return await sseProxy(request, env, url);
      if (path.startsWith("/firebase/")) return await restProxy(request, env, url);
      if (path === "/api/exchange" && request.method === "POST") return await handleExchange(request, env);
      if (path === "/api/trivia") return await handleTrivia(request, env, ctx);
      if (path === "/api/time") return await handleTime(request, env);
      if (path === "/privacy") return html(STATIC["privacy.html"]);
      if (path === "/terms") return html(STATIC["terms.html"]);
      if (path === "/support") return await handleSupport();
      if (path === "/" || path === "") {
        return html(STATIC["index.html"]);
      }
      const assetPath = path.slice(1);
      const content = STATIC[assetPath];
      if (content !== undefined) {
        const ext = "." + (assetPath.split(".").pop() || "");
        return new Response(content, {
          headers: { "Content-Type": CONTENT_TYPES[ext] || "text/plain; charset=utf-8", "Cache-Control": "no-cache" },
        });
      }
      return notFound();
    } catch (err) {
      console.error("[EnglishTrivia] error:", err.message);
      return json({ error: "Internal error" }, 500);
    }
  },
};
