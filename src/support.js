/**
 * Support Developer — external link opener (final approach, 2026-08-08).
 *
 * HISTORY:
 *  1. /support worker proxy of voice-support → page rendered but DEAD in
 *     Discord (sandbox CSP blocks external + inline scripts).
 *  2. In-window modal + Paystack simple-checkout URL via openExternalLink →
 *     Paystack refused: "We could not start this transaction" (checkout URL
 *     params not accepted as constructed; direct checkout from the activity
 *     URL isn't reliable).
 *  3. FINAL (this file): tapping "Support Developer" opens the real donate
 *     page — https://walusimbi-leon1.github.io/voice-support/ — in the user's
 *     browser, where Paystack inline.js works normally (it's a regular GitHub
 *     Pages page). In Discord we use the ONLY sanctioned external-link API:
 *     discordSdk.commands.openExternalLink({url}) → one-time "Trust this
 *     domain" prompt → real browser. In a plain browser the native
 *     target="_blank" link just works.
 */

import { discordSdk, inDiscordFrame } from "./discord.js";

const SUPPORT_URL = "https://walusimbi-leon1.github.io/voice-support/";

function wireLinks() {
  const links = document.querySelectorAll(
    "a.support-link, a.support-chip, a[href='/support'], a[href='" + SUPPORT_URL + "']"
  );
  links.forEach((a) => {
    a.addEventListener("click", (e) => {
      // Plain browser: native target="_blank" behavior is exactly right.
      if (!inDiscordFrame) return;
      // Discord sandbox: external navigation is blocked — use the SDK.
      e.preventDefault();
      if (discordSdk && typeof discordSdk.commands.openExternalLink === "function") {
        discordSdk.commands.openExternalLink({ url: SUPPORT_URL }).catch((err) => {
          console.error("[support] openExternalLink failed:", err);
          window.open(SUPPORT_URL, "_blank");
        });
      } else {
        window.open(SUPPORT_URL, "_blank");
      }
    });
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", wireLinks);
} else {
  wireLinks();
}
