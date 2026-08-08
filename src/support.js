/**
 * Support Developer — in-window donate modal.
 *
 * WHY THIS FILE EXISTS (Discord sandbox reality, verified 2026-08-08):
 *  - Discord's Activity sandbox routes ALL network traffic through its proxy
 *    with a strict CSP — external scripts (e.g. js.paystack.co/v1/inline.js)
 *    fail with "blocked:csp", and inline <script> in proxied pages is also
 *    unreliable. That's why the old /support proxy page rendered but was dead.
 *  - The ONLY Discord-sanctioned way to open external links is
 *    discordSdk.commands.openExternalLink({ url }) — Discord shows a
 *    one-time "Trust this domain" prompt and opens the user's real browser,
 *    where Paystack's checkout page fully works (card/PayPal/Apple Pay/GPay).
 *  - So: the support UI lives HERE, inside the game (same-origin module,
 *    same CSP-safe pattern as app.js). Clicking "Pay" hands a Paystack
 *    simple-checkout URL to openExternalLink (Discord) or window.open
 *    (plain browser).
 *
 * Paystack checkout URL (no secret key needed):
 *   https://checkout.paystack.com/{PUBLIC_KEY}?email=&amount=&currency=&reference=&callback_url=
 *   — the exact page PaystackPop.inline opens in its iframe; works in any
 *     real browser.
 */

import { discordSdk, inDiscordFrame } from "./discord.js";

const PAYSTACK_PUBLIC_KEY = "pk_live_40927e91c9c5f15bdd837752f55c3b0695db2737";
const PAYMENT_EMAIL = "support@voice-app.dev";
const AMOUNTS = [1, 2, 5, 10, 15, 30, 50, 100];

let selectedAmount = 1;
let modalRoot = null;

function slugify(s) {
  return (s || "game").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "game";
}

function buildCheckoutUrl(amountCents) {
  const origin = window.location.origin;
  const ref = `sgss-${slugify(document.title)}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const params = new URLSearchParams({
    email: PAYMENT_EMAIL,
    amount: String(amountCents),
    currency: "USD",
    reference: ref,
    callback_url: `${origin}/support?paid=1`,
  });
  return `https://checkout.paystack.com/${PAYSTACK_PUBLIC_KEY}?${params.toString()}`;
}

function openCheckout(url) {
  if (inDiscordFrame && discordSdk && typeof discordSdk.commands.openExternalLink === "function") {
    discordSdk.commands.openExternalLink({ url }).catch((err) => {
      console.error("[support] openExternalLink failed:", err);
      window.open(url, "_blank");
    });
  } else {
    window.open(url, "_blank");
  }
}

function closeModal() {
  if (modalRoot) modalRoot.remove();
  modalRoot = null;
}

function openModal() {
  if (modalRoot) return;
  modalRoot = document.createElement("div");
  modalRoot.id = "support-modal";
  modalRoot.innerHTML = `
  <div class="support-backdrop">
    <div class="support-card" role="dialog" aria-label="Support the developer">
      <button class="support-close" aria-label="Close">×</button>
      <div class="support-icon">💜</div>
      <h2>Support SGSS</h2>
      <p class="support-sub">Support SGSS and all its projects — open-source software, audiobooks, and more. Every contribution helps keep the work going.</p>
      <div class="support-amounts">
        ${AMOUNTS.map((a) => `<button class="support-amount${a === 1 ? " selected" : ""}" data-amount="${a}">$${a}</button>`).join("")}
        <button class="support-amount" data-amount="0">Custom</button>
      </div>
      <input type="number" id="support-custom" class="support-custom" placeholder="Enter amount in USD" min="1" step="0.01" style="display:none">
      <div class="support-error" style="display:none">Please enter an amount of at least $1</div>
      <button class="support-pay">💳 Pay Now</button>
      <p class="support-note">Secure checkout opens in your browser — supports Card, PayPal, Apple Pay &amp; Google Wallet</p>
    </div>
  </div>`;
  document.body.appendChild(modalRoot);

  const backdrop = modalRoot.querySelector(".support-backdrop");
  const closeBtn = modalRoot.querySelector(".support-close");
  const payBtn = modalRoot.querySelector(".support-pay");
  const errorEl = modalRoot.querySelector(".support-error");
  const customInput = modalRoot.querySelector("#support-custom");

  const setSelected = (btn) => {
    modalRoot.querySelectorAll(".support-amount").forEach((b) => b.classList.remove("selected"));
    btn.classList.add("selected");
  };

  modalRoot.querySelectorAll(".support-amount").forEach((btn) => {
    btn.addEventListener("click", () => {
      setSelected(btn);
      const amt = parseFloat(btn.dataset.amount);
      if (amt === 0) {
        selectedAmount = 0;
        customInput.style.display = "block";
        customInput.focus();
      } else {
        selectedAmount = amt;
        customInput.style.display = "none";
        customInput.value = "";
      }
      errorEl.style.display = "none";
    });
  });

  customInput.addEventListener("input", () => {
    const v = parseFloat(customInput.value);
    if (v && v >= 1) {
      selectedAmount = v;
      errorEl.style.display = "none";
    }
  });

  payBtn.addEventListener("click", () => {
    let amount = selectedAmount;
    if (!amount || amount < 1) {
      amount = parseFloat(customInput.value);
    }
    if (!amount || amount < 1) {
      errorEl.style.display = "block";
      return;
    }
    errorEl.style.display = "none";
    openCheckout(buildCheckoutUrl(Math.round(amount * 100)));
  });

  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) closeModal();
  });
  closeBtn.addEventListener("click", closeModal);
}

function wireLinks() {
  document.querySelectorAll("a.support-link, a.support-chip, a[href='/support']").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      openModal();
    });
  });
}

// Inject styles once (scoped under #support-modal).
const STYLE_ID = "support-modal-style";
if (!document.getElementById(STYLE_ID)) {
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
#support-modal .support-backdrop{position:fixed;inset:0;background:rgba(8,10,20,.78);backdrop-filter:blur(6px);z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
#support-modal .support-card{position:relative;background:linear-gradient(135deg,#0f0c29,#302b63,#24243e);color:#fff;max-width:440px;width:100%;border-radius:24px;padding:36px 28px;text-align:center;border:1px solid rgba(255,255,255,.12);box-shadow:0 24px 60px rgba(0,0,0,.5);max-height:90vh;overflow-y:auto}
#support-modal .support-close{position:absolute;top:12px;right:14px;background:none;border:none;color:rgba(255,255,255,.55);font-size:26px;line-height:1;cursor:pointer;padding:4px 8px}
#support-modal .support-close:hover{color:#fff}
#support-modal .support-icon{font-size:44px;margin-bottom:10px}
#support-modal h2{font-size:24px;font-weight:700;margin:0 0 8px}
#support-modal .support-sub{color:rgba(255,255,255,.62);font-size:13.5px;line-height:1.55;margin:0 0 24px}
#support-modal .support-amounts{display:grid;grid-template-columns:repeat(3,1fr);gap:9px;margin-bottom:18px}
#support-modal .support-amount{background:rgba(255,255,255,.07);border:2px solid rgba(255,255,255,.13);border-radius:12px;padding:12px 6px;color:#fff;font-size:15px;font-weight:600;cursor:pointer;transition:all .15s}
#support-modal .support-amount:hover,#support-modal .support-amount.selected{background:rgba(99,102,241,.28);border-color:#6366f1}
#support-modal .support-custom{width:100%;padding:13px 14px;background:rgba(255,255,255,.07);border:2px solid rgba(255,255,255,.13);border-radius:12px;color:#fff;font-size:15px;margin-bottom:18px;outline:none;box-sizing:border-box}
#support-modal .support-custom:focus{border-color:#6366f1}
#support-modal .support-error{color:#f87171;font-size:13px;margin-bottom:12px}
#support-modal .support-pay{width:100%;padding:15px;background:linear-gradient(135deg,#6366f1,#8b5cf6);border:none;border-radius:12px;color:#fff;font-size:16px;font-weight:700;cursor:pointer}
#support-modal .support-pay:hover{filter:brightness(1.08)}
#support-modal .support-note{color:rgba(255,255,255,.42);font-size:11.5px;margin-top:14px;line-height:1.5}
`;
  document.head.appendChild(style);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", wireLinks);
} else {
  wireLinks();
}
