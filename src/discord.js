/**
 * English Trivia — Discord SDK integration
 *
 * Proven pattern from Arrow Blast / Trivia Rumble Elite (2026-08-06), which
 * runs smoothly in Discord:
 *  - Vendored same-origin SDK (@discord/embedded-app-sdk@2.5.0) — Discord's
 *    Activity sandbox blocks external hosts (jsDelivr/gstatic fetch failed).
 *  - authorize() handles BOTH result shapes:
 *      { access_token } → Public Client / PKCE → authenticate() directly
 *      { code }         → confidential → /api/exchange → authenticate()
 *  - authenticate({ access_token }) returns { user } — getUser() requires
 *    an explicit id in SDK 2.5.0 and fails with "child id is required".
 *  - channelId comes free from sdk.channelId (URL params Discord adds).
 */

import { DiscordSDK } from "./vendor/discord-sdk.mjs";

// Discord Application Client ID — Discord injects ?client_id= into the
// Activity iframe URL, so the URL param wins. This constant is the
// fallback for direct links (REAL app ID — placeholder broke the authorize
// prompt; bible-trivia pattern, fixed 2026-08-08).
const CLIENT_ID = "1535697137533194271";

export let discordSdk = null;
export let isDiscord = false;
export let channelId = "lobby";

export const inDiscordFrame = (() => {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  return params.has("frame_id") || params.has("instance_id");
})();

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("[discord] " + label + " timed out after " + ms + "ms")), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

export async function initDiscord() {
  if (!inDiscordFrame) {
    isDiscord = false;
    channelId = new URLSearchParams(window.location.search).get("channel_id") || "lobby";
    return { isDiscord: false, channelId, user: null };
  }

  try {
    const params = new URLSearchParams(window.location.search);
    const clientId = params.get("client_id") || CLIENT_ID;
    if (!clientId) {
      console.warn("[discord] no client_id in URL — running as guest");
      return { isDiscord: true, channelId: params.get("channel_id") || "lobby", user: null };
    }
    discordSdk = new DiscordSDK(clientId);
    await withTimeout(discordSdk.ready(), 8000, "sdk.ready");
    isDiscord = true;
    channelId = discordSdk.channelId || "lobby";

    const user = await runAuthorize(clientId);
    return { isDiscord: true, channelId, user };
  } catch (err) {
    console.error("[Discord] init failed:", err);
    isDiscord = false;
    return { isDiscord: false, channelId: "lobby", user: null };
  }
}

async function runAuthorize(clientId) {
  if (!discordSdk) return null;

  const result = await withTimeout(
    discordSdk.commands.authorize({ client_id: clientId, scope: ["identify"] }),
    12000,
    "authorize",
  );
  if (!result) return null;

  // Public client (PKCE): the SDK returns an access_token directly.
  if (result.access_token) {
    const auth = await withTimeout(
      discordSdk.commands.authenticate({ access_token: result.access_token }),
      5000,
      "authenticate",
    );
    return auth?.user ?? null;
  }

  // Confidential client: returns a code → exchange via our worker.
  if (result.code) {
    const tokenResp = await fetch("/api/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: result.code }),
    });
    if (!tokenResp.ok) return null;
    const { access_token } = await tokenResp.json();
    if (!access_token) return null;
    const auth = await withTimeout(
      discordSdk.commands.authenticate({ access_token }),
      5000,
      "authenticate",
    );
    return auth?.user ?? null;
  }

  return null;
}
