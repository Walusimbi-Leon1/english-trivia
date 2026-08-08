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
  try {
    const upstream = await fetch(SUPPORT_URL, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; EnglishTrivia/1.0)" },
    });
    if (!upstream.ok) throw new Error(`upstream ${upstream.status}`);
    let page = await upstream.text();
    const bar =
      '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;background:#0a1428;color:#fff;padding:12px 16px;font-size:14px;text-align:center;border-bottom:1px solid rgba(255,255,255,0.12)">' +
      '<a href="/" style="color:#ffd76a;text-decoration:none;font-weight:600">← Back to English Trivia</a>' +
      '</div>';
    page = page.replace(/<body[^>]*>/i, (m) => m + bar);
    return new Response(page, {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" },
    });
  } catch (err) {
    return json({ error: "Support page temporarily unavailable" }, 502);
  }
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
For every question include a "ref" — the source phrase or category, like "idiom: bite the bullet" or "proverb: all that glitters is not gold".
Return ONLY a JSON array (no markdown) with exactly this structure:
[{"question":"Question text?","options":["A","B","C","D"],"correctAnswer":0,"ref":"idiom: bite the bullet"}]
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

    if (bankLen > BANK_MAX) {
      const patch = {};
      allAccepted.forEach((q, i) => (patch[i] = q));
      await fbPut(env, `${P}/bank`, patch);
      await fbDelete(env, `${P}/answers`).catch(() => {});
      await fbPut(env, `${P}/game`, {
        questionStart: Date.now(),
        slotDuration: SLOT_DURATION,
        bankLen: allAccepted.length,
        startedAt: Date.now(),
      });
      await fbPut(env, `${P}/meta`, { generating: 0, used: (await readUsed(env)) });
      return json({ bankLen: allAccepted.length, reset: true, source: fromStatic ? "seed" : "ai" });
    }

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
        const patch = {};
        fresh.forEach((q, i) => (patch[len + i] = q));
        await fbPatch(env, `${P}/bank`, patch);
        const game = await fbGet(env, `${P}/game`).catch(() => null);
        if (game) await fbPatch(env, `${P}/game`, { bankLen: len + fresh.length });
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
      if (path === "/support") return await handleSupport(request);
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
