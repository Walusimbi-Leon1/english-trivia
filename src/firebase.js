/**
 * English Trivia — data layer (Firebase Realtime Database)
 *
 * Proven pattern from Trivia Rumble Elite / Dice Arena: ALL traffic goes
 * through the same-origin /firebase proxy on our worker, because Discord's
 * Activity sandbox blocks direct firebaseio.com calls. The worker proxies:
 *  - REST reads/writes  → /firebase/<path>.json
 *  - Realtime streaming → /firebase/stream/<path>.json (SSE)
 * No Firebase SDK needed. Works identically in Discord and in browsers.
 *
 * Namespace: english/global  (shared RTDB, isolated from other games)
 */

const FB = "/firebase";
const NS = "pop-party-1-default-rtdb";

function ns(path) {
  const sep = path.includes("?") ? "&" : "?";
  // Firebase REST requires the .json suffix — without it the request hits the
  // legacy secret-key endpoint and returns 401/405.
  return `${FB}/${path}.json${sep}ns=${NS}`;
}

async function fbRequest(path, method, body) {
  const url = ns(path);
  let res = await fetch(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  // Some sandboxes/edges only allow GET+POST (405 on PUT/PATCH/DELETE).
  // Fall back to POST with X-Fb-Method — the worker honors it as the
  // upstream method. Belt-and-braces for Discord's Activity sandbox.
  if (!res.ok && method !== "GET" && method !== "POST") {
    console.warn(`[fb] ${method} → ${res.status}, retrying via POST`);
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Fb-Method": method,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export function dbRead(path) {
  return fbRequest(path, "GET");
}

export function dbWrite(path, data) {
  return fbRequest(path, "PUT", data);
}

export function dbUpdate(path, data) {
  return fbRequest(path, "PATCH", data);
}

export function dbDelete(path) {
  return fbRequest(path, "DELETE");
}

/**
 * Subscribe to realtime updates for a path (SSE via the worker proxy).
 * Firebase SSE emits named events `put` / `patch` with
 * data: {"path": "/players/abc/score", "data": 4}
 * onPatch receives (relPath, data). Returns the EventSource.
 */
export function dbWatch(path, onPatch) {
  const es = new EventSource(`${FB}/stream/${path}.json?ns=${NS}&t=${Date.now()}`);
  es.addEventListener("put", (ev) => {
    try {
      const d = JSON.parse(ev.data);
      onPatch(d.path || "/", d.data);
    } catch (e) {
      console.warn("[fb] bad put event", e);
    }
  });
  es.addEventListener("patch", (ev) => {
    try {
      const d = JSON.parse(ev.data);
      onPatch(d.path || "/", d.data);
    } catch (e) {
      console.warn("[fb] bad patch event", e);
    }
  });
  return es;
}
