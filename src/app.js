/**
 * English Trivia 📚 — client
 *
 * Single GLOBAL room. Every player sees the same question at the same time:
 *   slot = floor((now - game.questionStart) / slotDuration)
 *   question = bank[slot % bank.length]
 * Questions rotate continuously (20s each), generated from the repo's
 * English phrase corpus (idioms, proverbs, colloquialisms, jargon,
 * euphemisms, maxims & aphorisms, clichés) by opencode.ai big-pickle via
 * the GitHub Actions pipeline. Speed-based scoring:
 * first correct answer in a slot scores highest. Players + scores persist in
 * Firebase — leaving never deletes them.
 */

import { initDiscord, isDiscord, inDiscordFrame } from "./discord.js";
import { dbRead, dbWrite, dbUpdate, dbDelete } from "./firebase.js";

// ── Constants ────────────────────────────────────────────────────────────────
const SLOT_DURATION = 20000;   // must match worker
const TOP_UP_THRESHOLD = 20;   // request more questions when fewer remain

// ── State ────────────────────────────────────────────────────────────────────
let me = { id: null, username: "Guest", avatarUrl: "", score: 0 };
let game = null;       // { questionStart, slotDuration, bankLen }
let bank = [];         // array of { question, options, correctAnswer, ref? }
let players = {};      // uid → player
let answers = {};      // uid → { answer, at } for current slot
let offset = 0;        // clock offset (server - client)
let currentSlot = -1;
let myAnswer = null;
let hasAnswered = false;
let revealed = false;
let requestingBank = false;
let lastAnswerGain = 0;

const $ = (id) => document.getElementById(id);
const now = () => Date.now() + offset;

// ── SVG icon helpers (crisp at any size, no plain emoji) ────────────────────
const DISCORD_LOGO =
  '<svg viewBox="0 0 127.14 96.36" aria-hidden="true"><path fill="currentColor" d="M107.7 8.07A105.15 105.15 0 0 0 81.47 0a72.06 72.06 0 0 0-3.36 6.83 97.68 97.68 0 0 0-39.11 0A72.37 72.37 0 0 0 35.64 0 105.89 105.89 0 0 0 9.39 8.09C-7.21 32.65-1.71 56.6.54 80.21h0A105.73 105.73 0 0 0 32.71 96.36a77.7 77.7 0 0 0 6.89-11.11 68.42 68.42 0 0 1-10.85-5.18c.91-.66 1.8-1.34 2.66-2a75.57 75.57 0 0 0 64.32 0c.87.71 1.76 1.39 2.66 2a68.68 68.68 0 0 1-10.87 5.19 77 77 0 0 0 6.89 11.1A105.25 105.25 0 0 0 126.6 80.22h0C129.24 52.84 122.09 29.11 107.7 8.07ZM42.45 65.69C36.18 65.69 31 60 31 53s5-12.74 11.43-12.74S54 46 53.89 53 48.84 65.69 42.45 65.69Zm42.24 0C78.41 65.69 73.25 60 73.25 53s5-12.74 11.44-12.74S96.23 46 96.12 53 91.08 65.69 84.69 65.69Z"/></svg>';
const GLOBE_LOGO =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 12h18M12 3c3.2 3.6 3.2 14.4 0 18M12 3c-3.2 3.6-3.2 14.4 0 18" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
function starSvg(size = 14) {
  return `<svg class="star" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2.6l2.85 6.02 6.65.82-4.9 4.56 1.28 6.56L12 17.3l-5.88 3.26 1.28-6.56-4.9-4.56 6.65-.82z"/></svg>`;
}
function crownSvg(size = 14) {
  return `<svg class="crown" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 17V9.5l4.5 3.5L12 7.5l4.5 5.5L21 9.5V17z"/></svg>`;
}
function rankBadge(rank) {
  if (rank === 1) return `<span class="rank-badge gold" title="#1">${crownSvg(15)}</span>`;
  if (rank === 2) return `<span class="rank-badge silver" title="#2">2</span>`;
  if (rank === 3) return `<span class="rank-badge bronze" title="#3">3</span>`;
  return `<span class="rank-badge n">${rank}</span>`;
}
function platformBadge(p) {
  if (p?.platform === "discord") return `<span class="plat-badge discord" title="Playing from Discord">${DISCORD_LOGO}</span>`;
  return `<span class="plat-badge browser" title="Playing in browser">${GLOBE_LOGO}</span>`;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function initials(name) {
  return (name || "?").trim().charAt(0).toUpperCase() || "?";
}
function avatarHtml(player, size = 40) {
  const name = escapeHtml(initials(player?.username));
  const style = `width:${size}px;height:${size}px`;
  if (player?.avatarUrl) {
    return `<img class="avatar" style="${style}" src="${escapeHtml(player.avatarUrl)}" alt="" onerror="this.outerHTML='<span class=&quot;avatar avatar-fallback&quot; style=&quot;${style}&quot;>${name}</span>'">`;
  }
  return `<span class="avatar avatar-fallback" style="${style}">${name}</span>`;
}
function bankArray(obj) {
  if (!obj || typeof obj !== "object") return [];
  return Object.keys(obj)
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => obj[k])
    .filter(Boolean);
}
function showScreen(name) {
  ["loading", "error", "game"].forEach((s) => {
    const el = $(`screen-${s}`);
    if (el) el.classList.toggle("hidden", s !== name);
  });
}

// ── Question timing (deterministic, shared by all players) ──────────────────
// No modulo wrap-around: each bank index is played exactly once, so questions
// never repeat. The worker tops the bank up ahead of the current slot; if the
// bank is momentarily exhausted the client shows "Preparing new questions…".
function currentQuestion() {
  if (!game || !game.questionStart || !bank.length) return null;
  const duration = game.slotDuration || SLOT_DURATION;
  const elapsed = Math.max(0, now() - game.questionStart);
  const slot = Math.floor(elapsed / duration);
  if (slot >= bank.length) return null;   // bank exhausted — wait for top-up
  const q = bank[slot];
  if (!q) return null;
  return {
    slot,
    index: slot + 1,          // human-friendly "Question #N"
    question: q,
    slotStart: game.questionStart + slot * duration,
    slotEnd: game.questionStart + (slot + 1) * duration,
  };
}

// ── Firebase paths ──────────────────────────────────────────────────────────
const P = "english/global";

// ── Realtime sync (robust polling) ─────────────────────────────────────────
// NOTE: Firebase SSE through the Cloudflare Worker proxy freezes after the
// initial snapshot (verified 2026-08-08) — live updates never arrive. So we
// poll players + the current slot's answers every few seconds instead. The
// game is 20s/slot, so 3s polling keeps everything fresh with tiny load.
function startSync() {
  const visible = () => document.visibilityState !== "hidden";

  const syncPlayers = async () => {
    try {
      const data = await dbRead(`${P}/players`).catch(() => null);
      if (data && typeof data === "object") {
        players = data;
        refresh();
      }
    } catch (e) {
      /* keep last known state */
    }
  };

  const syncAnswers = async () => {
    if (currentSlot < 0) return;
    try {
      const data = await dbRead(`${P}/answers/${currentSlot}`).catch(() => null);
      if (data && typeof data === "object") {
        answers = data;
        refresh();
      }
    } catch (e) {
      /* keep last known state */
    }
  };

  const beat = () => {
    if (!visible()) return;   // save bandwidth while the tab is hidden
    syncPlayers();
    syncAnswers();
  };

  beat();
  setInterval(beat, 3000);
  document.addEventListener("visibilitychange", () => {
    if (visible()) {
      syncPlayers();
      syncAnswers();
    }
  });
}

// ── Boot: identity ──────────────────────────────────────────────────────────
async function resolveIdentity() {
  const discordInfo = await initDiscord();
  if (discordInfo.user) {
    return {
      id: "u" + discordInfo.user.id,
      username: discordInfo.user.global_name || discordInfo.user.username || "Player",
      avatarUrl: `https://cdn.discordapp.com/avatars/${discordInfo.user.id}/${discordInfo.user.avatar || "0"}.png`,
      platform: "discord",
    };
  }
  // Guest: stable id in localStorage so scores persist across reloads.
  // Browser and Discord-fallback guests use SEPARATE keys, so the same person
  // playing in a Discord Activity AND a browser tab gets two distinct records
  // instead of the two sessions fighting over one id.
  const key = inDiscordFrame ? "bt_guest_id_discord" : "bt_guest_id";
  let gid = null;
  try {
    gid = localStorage.getItem(key);
  } catch (e) { /* private mode */ }
  if (!gid) {
    gid = "g" + Math.random().toString(36).slice(2, 10);
    try {
      localStorage.setItem(key, gid);
    } catch (e) { /* ignore */ }
  }
  return {
    id: gid,
    username: guestNameFromId(gid),  // stable + unique per session
    avatarUrl: "",
    platform: isDiscord ? "discord" : "browser",
  };
}

// Deterministic guest name derived from the id: stable across reloads and
// unique per session (no shared localStorage name collisions).
function guestNameFromId(gid) {
  let sum = 0;
  for (const c of gid) sum = (sum * 31 + c.charCodeAt(0)) % 997;
  return "Guest " + (100 + (sum % 900));
}

// ── Sync clock with the worker ──────────────────────────────────────────────
async function syncTime() {
  try {
    const res = await fetch("/api/time");
    if (res.ok) {
      const data = await res.json();
      offset = data.now - Date.now();
      if (data.game && (!game || !game.questionStart)) game = data.game;
    }
  } catch (e) {
    /* keep previous offset */
  }
}

// ── Join (persistent player record) ─────────────────────────────────────────
async function joinGlobal() {
  const existing = await dbRead(`${P}/players/${me.id}`).catch(() => null);
  if (existing && typeof existing === "object") {
    me.score = existing.score || 0;
    await dbUpdate(`${P}/players/${me.id}`, {
      username: me.username,
      avatarUrl: me.avatarUrl,
      platform: isDiscord ? "discord" : "browser",
      online: true,
      lastSeen: Date.now(),
    });
  } else {
    await dbWrite(`${P}/players/${me.id}`, {
      id: me.id,
      username: me.username,
      avatarUrl: me.avatarUrl,
      platform: isDiscord ? "discord" : "browser",
      score: 0,
      online: true,
      lastSeen: Date.now(),
      joinedAt: Date.now(),
    });
  }
  players = (await dbRead(`${P}/players`).catch(() => ({}))) || {};
  me.score = players[me.id]?.score || 0;
}

// ── Bank management ─────────────────────────────────────────────────────────
async function ensureBank(force) {
  if (requestingBank) return;
  requestingBank = true;
  try {
    const snapshot = await dbRead(`${P}/bank`).catch(() => null);
    bank = bankArray(snapshot);
    let need = !!force;
    if (!need && game && game.questionStart) {
      const duration = game.slotDuration || SLOT_DURATION;
      const slot = Math.floor((now() - game.questionStart) / duration);
      need = bank.length - (slot + 1) < TOP_UP_THRESHOLD;
    }
    if (!need) return;

    const res = await fetch("/api/trivia", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ count: 20 }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.bankLen) {
        const fresh = await dbRead(`${P}/bank`).catch(() => null);
        bank = bankArray(fresh);
        const g = await dbRead(`${P}/game`).catch(() => null);
        if (g) game = g;
      }
    }
  } catch (e) {
    console.warn("ensureBank failed:", e);
  } finally {
    requestingBank = false;
  }
}

// ── Answering ───────────────────────────────────────────────────────────────
function pointsFor(elapsedMs) {
  // Speed-based: 100 - 5 per second elapsed, min 10. First correct = highest.
  const seconds = elapsedMs / 1000;
  return Math.max(10, Math.floor(100 - seconds * 5));
}

async function handleAnswer(idx, q) {
  if (hasAnswered || !q) return;
  hasAnswered = true;
  myAnswer = idx;
  const at = now();
  const elapsed = Math.max(0, at - q.slotStart);

  // optimistic local update
  answers[me.id] = { answer: idx, at };
  refresh();

  try {
    await dbUpdate(`${P}/answers/${q.slot}/${me.id}`, { answer: idx, at });
  } catch (e) {
    console.warn("answer write failed:", e);
  }

  if (idx === q.question.correctAnswer) {
    const gain = pointsFor(elapsed);
    me.score += gain;
    lastAnswerGain = gain;
    try {
      await dbUpdate(`${P}/players/${me.id}`, { score: me.score, lastSeen: Date.now() });
    } catch (e) {
      console.warn("score write failed:", e);
    }
  } else {
    lastAnswerGain = 0;
  }

  setTimeout(() => {
    revealed = true;
    renderQuestion(q);
  }, 250);
}

// ── Rendering ───────────────────────────────────────────────────────────────
function renderHeader() {
  const el = $("header-me");
  if (!el) return;
  el.innerHTML =
    avatarHtml(me, 28) +
    `<span class="me-name">${escapeHtml(me.username)}</span>` +
    `<span class="me-score">${starSvg(13)} ${me.score}</span>` +
    `<span class="tag ${isDiscord ? "tag-discord" : "tag-browser"}">${isDiscord ? "DISCORD" : "BROWSER"}</span>`;
}

function renderQuestion(q) {
  const question = q.question;
  $("q-number").textContent = `Question ${q.index}`;
  updateAnsweredCount();

  $("q-text").textContent = question.question;

  // Phrase reference (questions carry a ref, e.g. "idiom: bite the bullet")
  const refEl = $("q-ref");
  if (refEl) {
    if (question.ref) {
      refEl.textContent = `📖 ${question.ref}`;
      refEl.classList.remove("hidden");
    } else {
      refEl.classList.add("hidden");
    }
  }

  $("q-options").innerHTML = question.options
    .map((opt, i) => {
      let cls = "opt-btn";
      if (revealed) {
        if (i === question.correctAnswer) cls += " correct";
        else if (i === myAnswer) cls += " wrong";
        else cls += " dimmed";
      }
      return `<button class="${cls}" data-idx="${i}" ${hasAnswered ? "disabled" : ""}>
        <span class="opt-letter">${String.fromCharCode(65 + i)}</span>
        <span class="opt-text">${escapeHtml(opt)}</span>
      </button>`;
    })
    .join("");

  document.querySelectorAll(".opt-btn").forEach((btn) => {
    btn.onclick = () => handleAnswer(Number(btn.dataset.idx), q);
  });

  const box = $("q-result");
  if (revealed) {
    box.classList.remove("hidden");
    box.classList.toggle("good", myAnswer === question.correctAnswer);
    box.classList.toggle("bad", myAnswer !== question.correctAnswer);
    box.innerHTML =
      myAnswer === question.correctAnswer
        ? `✅ Correct! +${lastAnswerGain} ⚡`
        : myAnswer === -1
          ? `⏰ Time's up! The answer was: ${escapeHtml(question.options[question.correctAnswer])}`
          : `❌ Wrong! The answer was: ${escapeHtml(question.options[question.correctAnswer])}`;
  } else {
    box.classList.add("hidden");
  }
}

function updateAnsweredCount() {
  const answeredCount = Object.keys(answers).length;
  const onlineCount = Math.max(1, Object.values(players).filter(isLive).length);
  const el = $("q-answered");
  if (el) el.textContent = `⚡ ${answeredCount}/${onlineCount} answered`;
}

function renderLeaderboard() {
  const LB_TOP = 7;   // top tier shown before the divider

  const all = Object.values(players).filter((p) => p && typeof p === "object");
  // Always include yourself — even if the players map is stale/empty on boot,
  // your row renders so you can never be "missing" from the board.
  if (!all.some((p) => p.id === me.id)) all.push({ ...me, online: true, lastSeen: Date.now() });

  const sorted = all.sort(
    (a, b) => (b.score || 0) - (a.score || 0) || (b.lastSeen || 0) - (a.lastSeen || 0)
  );
  const myIdx = sorted.findIndex((p) => p.id === me.id);
  const myRank = myIdx + 1;

  // Order: top 7, divider, then me pinned as #8 when I'm outside the top tier
  // (players between 8 and me appear below me for scrolling). Ranks stay true.
  const ranked = sorted.map((p, i) => ({ p, rank: i + 1 }));
  const ordered =
    myRank > LB_TOP
      ? [
          ...ranked.slice(0, LB_TOP),
          ranked[myIdx],
          ...ranked.slice(LB_TOP, myIdx),
          ...ranked.slice(myIdx + 1),
        ]
      : ranked;

  const el = $("lb-list");
  if (!el) return;
  const liveCount = sorted.filter(isLive).length;
  const titleEl = $("lb-title");
  if (titleEl) {
    titleEl.innerHTML =
      `Leaderboard <span class="lb-meta">${sorted.length} players · ` +
      `<span class="lb-live"><span class="lb-live-dot"></span>${liveCount} live</span></span>`;
  }

  el.innerHTML = ordered.length
    ? ordered
        .map((item, i) => {
          const p = item.p;
          const rank = item.rank;
          const isOffline = !isLive(p);
          const mine = p.id === me.id;
          const divider = i === LB_TOP ? '<div class="lb-divider"><span></span>· · ·<span></span></div>' : "";
          return (
            divider +
            `
          <div class="lb-row ${mine ? "me" : ""} ${rank === 1 ? "first" : ""} ${isOffline ? "offline" : ""}">
            <span class="lb-rank">${rankBadge(rank)}</span>
            ${avatarHtml(p, 32)}
            <span class="lb-name">${escapeHtml(p.username)}${mine ? '<span class="you-tag">you</span>' : ""}</span>
            ${platformBadge(p)}
            <span class="lb-score">${starSvg(11)} ${p.score || 0}</span>
          </div>`
          );
        })
        .join("")
    : '<p class="muted center small">No players yet — open the game and be first!</p>';

  const rankEl = $("my-rank");
  if (rankEl) {
    rankEl.innerHTML = `Your rank: <b>#${myRank}</b> · ${starSvg(11)} ${me.score || 0} pts`;
  }
}

function refresh() {
  renderHeader();
  renderLeaderboard();
  const gameScreen = $("screen-game");
  if (gameScreen && !gameScreen.classList.contains("hidden")) {
    updateAnsweredCount();
  }
}

function showError(msg) {
  $("error-msg").textContent = msg;
  showScreen("error");
}

// ── Presence ────────────────────────────────────────────────────────────────
// A player is "live" only if their heartbeat is FRESH. The raw `online` flag
// alone is unreliable: it's set true on join and only flipped false on
// visibilitychange / beforeunload — which rarely fire inside Discord's
// embedded Activity (the webview is silently destroyed when a user leaves the
// voice channel). Result: every past player stayed `online:true` forever and
// the live count ballooned (e.g. 65 "live" of 67 total when nobody was playing).
// `lastSeen` is written every 30s by the heartbeat below, so freshness is the
// source of truth: online + recent heartbeat = live.
const LIVE_STALE_MS = 180000; // 3 min without a heartbeat → offline

function isLive(p) {
  return !!(
    p &&
    p.online &&
    p.lastSeen &&
    Date.now() - Number(p.lastSeen) < LIVE_STALE_MS
  );
}

function startPresence() {
  const beat = async () => {
    try {
      await dbUpdate(`${P}/players/${me.id}`, {
        online: document.visibilityState !== "hidden",
        lastSeen: Date.now(),
      });
    } catch (e) { /* ignore */ }
  };
  beat();
  setInterval(beat, 30000);
  document.addEventListener("visibilitychange", beat);
  window.addEventListener("beforeunload", () => {
    try {
      dbUpdate(`${P}/players/${me.id}`, { online: false, lastSeen: Date.now() });
    } catch (e) { /* ignore */ }
  });
}

// ── Main loop ───────────────────────────────────────────────────────────────
async function loadSlotAnswers(slot) {
  const data = await dbRead(`${P}/answers/${slot}`).catch(() => null);
  answers = data && typeof data === "object" ? data : {};
  refresh();
}

function maybeTopUp(q) {
  const remaining = bank.length - q.slot;   // no modulo — slots consume the bank linearly
  if (remaining < TOP_UP_THRESHOLD && !requestingBank) {
    ensureBank();
  }
}

function tick() {
  const q = currentQuestion();
  if (!q) {
    if (!game || !bank.length) {
      $("loading-msg").textContent = "Connecting to the arena…";
    } else {
      // bank momentarily exhausted — worker is topping up with fresh questions
      $("loading-msg").textContent = "Preparing new questions…";
      ensureBank(true);
    }
    showScreen("loading");
    return;
  }

  // New question slot → reset local state
  if (q.slot !== currentSlot) {
    currentSlot = q.slot;
    myAnswer = null;
    hasAnswered = false;
    revealed = false;
    answers = {};
    loadSlotAnswers(q.slot);
    maybeTopUp(q);
    renderQuestion(q);
  }

  // Timer bar
  const remaining = Math.max(0, q.slotEnd - now());
  const pct = (remaining / SLOT_DURATION) * 100;
  const bar = $("q-progress");
  if (bar) {
    bar.style.width = pct + "%";
    bar.classList.toggle("danger", remaining < 5000);
  }
  const tEl = $("q-time");
  if (tEl) {
    tEl.textContent = Math.ceil(remaining / 1000) + "s";
    tEl.classList.toggle("danger", remaining < 5000);
  }

  // Time up → auto-reveal
  if (remaining <= 0 && !hasAnswered) {
    myAnswer = -1;
    hasAnswered = true;
    revealed = true;
    renderQuestion(q);
  }

  showScreen("game");
}

// ── Boot ─────────────────────────────────────────────────────────────────────
async function boot() {
  showScreen("loading");

  // OAuth popup (Discord web-client authorize): show confirmation, don't boot.
  if (window.opener && !window.opener.closed) {
    $("screen-loading").classList.add("hidden");
    $("screen-error").classList.add("hidden");
    const gs = $("screen-game");
    gs.classList.remove("hidden");
    gs.innerHTML = `<div class="card center-box" style="min-height:40vh">
      <div style="font-size:52px">✅</div>
      <h2>You're connected!</h2>
      <p class="muted">Return to the game — your Discord name is ready.</p>
    </div>`;
    return;
  }

  const identity = await resolveIdentity();
  me = identity;
  renderHeader();

  // Every step is independently resilient — one failure must never brick the
  // whole game. Firebase writes failing (sandbox restrictions, rate limits)
  // degrade to local-only play instead of an error screen.
  const fails = [];
  await syncTime();
  try {
    await joinGlobal();
  } catch (err) {
    fails.push("join: " + (err.message || err));
  }
  await ensureBank();
  startSync();
  startPresence();

  setInterval(tick, 100);
  setInterval(syncTime, 5 * 60 * 1000);
  $("btn-retry").onclick = () => window.location.reload();

  if (fails.length) {
    console.warn("Degraded boot:", fails);
    // still playable — local mode with the live question stream
  }
}

boot();
