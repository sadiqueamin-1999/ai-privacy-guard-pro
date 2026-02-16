// content.js (classic)
// - Detect AI UI & sensitive fields (no value reading)
// - Debounced messages to background
// - In-page router with strict Cancel behavior (blocking shield when PIN is required)
// - Respond to RULES_UPDATED to apply new policy immediately
// - Show clearer policy details (blocklisted flag)
// - SAFE: early-bail and guarded messaging for frames without chrome.runtime

(function () {
  // Only run on http/https documents
  if (!(location.protocol === "http:" || location.protocol === "https:")) return;

  // ---- Early runtime capability probe (per-frame) ----
  const RUNTIME_OK =
    typeof chrome !== "undefined" &&
    chrome.runtime &&
    typeof chrome.runtime.sendMessage === "function";

  // In some frames (about:blank/srcdoc/sandboxed), extension APIs aren't exposed.
  // Bail out quietly in those frames; the top or other frames will still handle UI.
  if (!RUNTIME_OK) {
    // console.debug("[AIPG content] No chrome.runtime in this frame; skipping:", location.href);
    return;
  }

  // ---- Start main content logic ----
  initAIPGContent();

  function initAIPGContent() {
    // Prevent re-opening while a router is active; reset on RULES_UPDATED/navigation
    window.__AIPG_SUPPRESS_ROUTER__ = window.__AIPG_SUPPRESS_ROUTER__ || false;

    const AI_SELECTORS = [
      "[data-ai]",
      "[aria-label*='AI']",
      "[class*='ai-']",
      "[class*='gpt']",
      "button[aria-label*='AI']",
      "button[aria-label*='Write with AI']",
      "textarea[placeholder*='Ask']",
      "textarea[placeholder*='Write']"
    ];

    let routerOpen = false;
    let lastSignalSentAt = 0;
    const SIGNAL_COOLDOWN_MS = 3000;

    // --- Safe messaging helper (runtime is known-good) ---
    function safeSendMessage(payload, cb) {
      try { chrome.runtime.sendMessage(payload, cb); } catch (_) {}
    }

    // Determine if current page is an AI domain (content-side)
    let AIPG_DOMAINS = [];
    let isAiDomainHere = false;

    safeSendMessage({ type: "REQUEST_AI_DOMAINS" }, (res) => {
      AIPG_DOMAINS = (res && res.domains) || [];
      try {
        const host = location.hostname.toLowerCase();
        isAiDomainHere = AIPG_DOMAINS.some(d => host === d || host.endsWith("." + d));
      } catch { isAiDomainHere = false; }
    });

    // DOM observer for in-app AI signals & sensitive fields
    const mo = new MutationObserver(() => maybeSignal());
    mo.observe(document.documentElement, { childList: true, subtree: true });

    function maybeSignal() {
      if (window.__AIPG_SUPPRESS_ROUTER__) return;
      const now = Date.now();
      if (now - lastSignalSentAt < SIGNAL_COOLDOWN_MS) return;

      const signals = detectAiUiSignals();
      const fields = detectSensitiveFields();
      const hasSignals = signals.length > 0;
      const hasSensitive = Object.values(fields).some(v => v > 0);

      if (hasSignals || hasSensitive) {
        lastSignalSentAt = now;
        safeSendMessage({
          type: "AI_UI_DETECTED",
          signals,
          sensitiveFields: fields,
          pageUrl: location.href,
          isAiDomainFromContent: isAiDomainHere
        });
      }
    }

    function detectAiUiSignals() {
      const found = [];
      for (const sel of AI_SELECTORS) {
        const el = document.querySelector(sel);
        if (el) {
          found.push(sel);
          if (found.length >= 5) break; // cap noise
        }
      }
      return found;
    }

    function detectSensitiveFields() {
      const res = { password: 0, email: 0, credit: 0, id: 0 };
      const inputs = document.querySelectorAll("input, textarea");
      inputs.forEach(el => {
        const type = (el.getAttribute("type") || "").toLowerCase();
        const name = (el.getAttribute("name") || "").toLowerCase();
        const id   = (el.getAttribute("id") || "").toLowerCase();
        const ph   = (el.getAttribute("placeholder") || "").toLowerCase();
        const blob = type + " " + name + " " + id + " " + ph;

        if (type === "password") res.password++;
        if (/email/.test(blob)) res.email++;
        if (/(credit|card|iban|cvc|cvv)/.test(blob)) res.credit++;
        if (/(employee|national|id|ssn|nin)/.test(blob)) res.id++;
      });
      return res;
    }

    // Optional prompt tracking (debounced)
    let promptTimer = null;
    const PROMPT_DEBOUNCE_MS = 600;
    function onPromptLikeInput(e) {
      const t = e.target;
      const text = extractText(t);
      if (!text) return;
      clearTimeout(promptTimer);
      promptTimer = setTimeout(() => {
        safeSendMessage({
          type: "PROMPT_ACTIVITY",
          text,
          tabUrl: location.href
        });
      }, PROMPT_DEBOUNCE_MS);
    }
    function extractText(el) {
      if (!el) return "";
      if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") return el.value || "";
      if (el.isContentEditable) return el.innerText || el.textContent || "";
      return "";
    }
    document.addEventListener("keyup", onPromptLikeInput, true);
    document.addEventListener("change", onPromptLikeInput, true);

    // React to rules/profile updates: allow router to re-open with new policy
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === "RULES_UPDATED") {
        window.__AIPG_SUPPRESS_ROUTER__ = false;
        const existing = document.querySelector(".aipg-overlay");
        if (existing) existing.remove(); // close any modal so new policy can show
      }
    });

    // Open router on request (respect suppression)
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === "OPEN_ROUTER") {
        if (window.__AIPG_SUPPRESS_ROUTER__) return;
        if (!routerOpen) {
          routerOpen = true;
          window.__AIPG_SUPPRESS_ROUTER__ = true; // prevent duplicates during active router
          renderRouter(msg).finally(() => { routerOpen = false; });
        }
      }
    });

    // ------------------ Router Modal ------------------
    async function renderRouter(payload) {
      const { reason, context, risk, profileId } = payload;

      const overlay = document.createElement("div");
      overlay.className = "aipg-overlay";
      overlay.innerHTML = `
        <div class="aipg-modal" role="dialog" aria-labelledby="aipg-title" aria-modal="true" tabindex="-1">
          <div class="aipg-header">
            <h2 id="aipg-title">AI Usage Detected</h2>
          </div>

          <p class="aipg-reason">${escapeHtml(reason || "AI activity detected")}</p>

          <div class="aipg-risk">
            <span class="badge ${riskBadge(risk)}" aria-live="polite">Risk: ${Number(risk) || 0}</span>
            <small class="aipg-tip" id="aipg-tip">Tip: Loading…</small>
          </div>

          <div class="aipg-details">
            ${context.isAiDomain ? `<div>• AI domain</div>` : ``}
            ${context.aiUiSignals?.length ? `<div>• AI UI on page (${context.aiUiSignals.length} signal${context.aiUiSignals.length>1?'s':''})</div>` : ``}
            ${anySensitive(context.sensitiveFields) ? `<div>• Sensitive fields present</div>` : ``}
            ${context.isInternalSite ? `<div>• Internal site</div>` : ``}
            ${context.blocklisted ? `<div>• <b>Blocklisted by policy</b></div>` : ``}
          </div>

          <div class="aipg-actions" style="display:flex; gap:8px; flex-wrap:wrap;">
            <button class="btn btn-secondary" id="aipg-cancel">Cancel</button>
            <button class="btn btn-primary" id="aipg-proceed">Proceed</button>
            <button class="btn btn-accent" id="aipg-redirect" title="Use approved internal AI">Use Approved AI</button>
          </div>

          <div class="aipg-checkboxes">
            <label><input type="checkbox" id="aipg-allow-site"> Always allow this site</label>
            <label><input type="checkbox" id="aipg-block-site"> Always block this site</label>
          </div>

          <div class="aipg-admin" id="aipg-admin" style="display:none;">
            <label>Admin PIN:
              <input type="password" id="aipg-pin" autocomplete="one-time-code" aria-label="Admin PIN">
            </label>
            <div class="aipg-note" id="aipg-note" style="font-size:12px;color:#666;display:none;margin-top:8px;">
              A valid Admin PIN is required to proceed on high‑risk interactions.
            </div>
          </div>

          <button class="aipg-close" aria-label="Close dialog">×</button>
        </div>
      `;
      document.documentElement.appendChild(overlay);

      const modal = overlay.querySelector(".aipg-modal");
      modal.focus();
      overlay.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
      overlay.querySelector(".aipg-close").onclick = close;

      // Safety tips (local JSON)
      fetch(chrome.runtime.getURL("assets/tips.json"))
        .then(r => r.json())
        .then(tips => {
          const tip = tips[Math.floor(Math.random() * tips.length)];
          const tipEl = overlay.querySelector("#aipg-tip");
          if (tipEl) tipEl.textContent = "Tip: " + tip;
        })
        .catch(() => {});

      // Determine if PIN is required (Strict + risk >= threshold)
      let pinRequired = false;
      safeSendMessage({ type: "GET_PROFILE" }, ({ profile }) => {
        if (profile?.requireAdminPinAboveThreshold && (risk >= (profile.riskThreshold || 100))) {
          pinRequired = true;
          overlay.querySelector("#aipg-admin").style.display = "block";
          overlay.querySelector("#aipg-note").style.display = "block";
        }
      });

      // Cancel: strict -> block with shield; lower risk -> dismiss
      overlay.querySelector("#aipg-cancel").onclick = async () => {
        if (pinRequired) {
          showBlockingShield();
          return;
        }
        await sendDecision("cancel", false);
        close();
      };

      // Proceed: strict -> validate PIN; else proceed
      overlay.querySelector("#aipg-proceed").onclick = async () => {
        if (pinRequired) {
          chrome.storage.local.get(["rules"], ({ rules }) => {
            const entered = overlay.querySelector("#aipg-pin").value;
            const adminPin = rules?.adminPin || "";
            if (!adminPin || entered !== adminPin) {
              alert("Admin PIN required.");
            } else {
              sendDecision("proceed", true).then(close);
            }
          });
          return;
        }
        await sendDecision("proceed", false);
        close();
      };

      // NEW: Redirect to approved AI
      overlay.querySelector("#aipg-redirect").onclick = async () => {
        chrome.storage.local.get(["approvedAiUrl"], ({ approvedAiUrl }) => {
          const url = (approvedAiUrl || "").trim();
          if (!url) {
            alert("Approved AI URL is not configured. Set it in Options.");
            return;
          }
          // Log a redirect decision, then navigate
          safeSendMessage({
            type: "ROUTER_DECISION",
            decision: "redirect",
            reason: overlay.querySelector(".aipg-reason")?.textContent || "",
            tabUrl: location.href,
            risk: risk,
            profileId: profileId,
            redirectedTo: url
          });
          // Navigate to approved AI
          try { window.location.href = url; } catch (_) { /* ignore */ }
          close();
        });
      };

      async function sendDecision(choice, pinVerified) {
        // Keep suppression after handling
        window.__AIPG_SUPPRESS_ROUTER__ = true;

        // Apply allow/block toggles
        const allowChecked = overlay.querySelector("#aipg-allow-site").checked;
        const blockChecked = overlay.querySelector("#aipg-block-site").checked;
        if (allowChecked || blockChecked) {
          const host = (new URL(location.href)).hostname;
          chrome.storage.local.get(["rules"], ({ rules }) => {
            const selectedId = rules?.selectedProfileId || "confirm";
            const profiles = rules?.profiles || [];
            const idx = profiles.findIndex(p => p.id === selectedId);
            if (idx >= 0) {
              const p = profiles[idx];
              p.allowList = p.allowList || [];
              p.blockList = p.blockList || [];
              if (allowChecked && !p.allowList.includes(host)) p.allowList.push(host);
              if (blockChecked && !p.blockList.includes(host)) p.blockList.push(host);
              profiles[idx] = p;
              rules.profiles = profiles;
              chrome.storage.local.set({ rules });
            }
          });
        }

        safeSendMessage({
          type: "ROUTER_DECISION",
          decision: choice,
          reason: overlay.querySelector(".aipg-reason")?.textContent || "",
          tabUrl: location.href,
          risk: risk,
          profileId: profileId,
          pinVerified: !!pinVerified
        });
      }

      function showBlockingShield() {
        // Full-screen shield that blocks page interaction until user backs out
        const shield = document.createElement("div");
        shield.style.position = "fixed";
        shield.style.inset = "0";
        shield.style.zIndex = "2147483647";
        shield.style.background = "rgba(0,0,0,0.55)";
        shield.style.display = "flex";
        shield.style.alignItems = "center";
        shield.style.justifyContent = "center";
        shield.style.backdropFilter = "blur(2px)";
        shield.innerHTML = `
          <div style="background:#fff;color:#111;max-width:520px;width:92%;padding:18px;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,0.35);font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;">
            <h3 style="margin:0 0 8px;">Action required</h3>
            <p style="margin:0 0 10px;">This interaction is classified as <b>high risk</b>. A valid Admin PIN is required to proceed.</p>
            <div style="display:flex;gap:10px;justify-content:flex-end;">
              <button id="aipg-shield-back" style="padding:8px 12px;border:0;border-radius:8px;background:#e0e0e0;cursor:pointer;">Return</button>
            </div>
          </div>
        `;
        document.documentElement.appendChild(shield);

        // Allow router to re-open if user triggers AI again (suppression off)
        window.__AIPG_SUPPRESS_ROUTER__ = false;

        shield.querySelector("#aipg-shield-back").onclick = () => {
          shield.remove();
        };
      }

      function close(){ overlay.remove(); }
    }

    // ---- small utils ----
    function anySensitive(obj){ return !!obj && Object.values(obj).some(v => v > 0); }
    function riskBadge(r){ const n = Number(r)||0; return n>=70?"badge-high":(n>=40?"badge-med":"badge-low"); }
    function escapeHtml(s){
      return String(s||"")
        .replace(/&/g,"&amp;")
        .replace(/</g,"&lt;")
        .replace(/>/g,"&gt;");
    }
  }
})();