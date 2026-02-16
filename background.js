// background.js (MV3 service worker - classic)
// Requires utils.js (classic) exposing helpers on self.AIPG
importScripts("utils.js");

const {
  computeRiskScore,
  isInternal,
  appendLog,
  sha256,
  getLocal,
  setLocal
} = self.AIPG;

// ------------------ In-memory caches ------------------
let aiDomainsCache = [];
let rulesCache = null;

// Dedup + consent caches (per SW lifecycle)
const lastOpenMap = new Map();    // key: `${tabId}|${host}` -> last open timestamp (ms)
const consentMap  = new Map();    // key: `${tabId}|${host}` -> { allowedUntil: ms }

// Tunables
const OPEN_COOLDOWN_MS = 5000;            // don't reopen within 5s for the same tab+host
const CONSENT_TTL_MS   = 10 * 60 * 1000;  // 10 minutes consent after Proceed

// ------------------ Boot ------------------
chrome.runtime.onInstalled.addListener(() => ensureBoot());
chrome.runtime.onStartup.addListener(() => ensureBoot());

async function ensureBoot() {
  try {
    const defaultsUrl = chrome.runtime.getURL("data/default_rules.json");
    const domainsUrl  = chrome.runtime.getURL("data/ai_domains.json");

    const [defaults, packagedDomains] = await Promise.all([
      fetch(defaultsUrl).then(r => r.json()),
      fetch(domainsUrl).then(r => r.json())
    ]);

    const { rules } = await getLocal(["rules"]);
    if (!rules) {
      await setLocal({ rules: defaults });
      rulesCache = defaults;
    } else {
      rulesCache = rules;
    }

    const { customDomains = [] } = await getLocal(["customDomains"]);
    aiDomainsCache = Array.from(new Set([...(customDomains || []), ...(packagedDomains || [])]));
  } catch (e) {
    console.warn("[AIPG] ensureBoot error:", e);
  }
}

// ------------------ React to rule/domain changes live ------------------
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;

  if (changes.rules) {
    // Refresh cached rules immediately
    rulesCache = changes.rules.newValue || rulesCache;

    // Clear recent-router and consent windows so new policy takes effect NOW
    lastOpenMap.clear();
    consentMap.clear();

    // Broadcast to all http(s) tabs so they clear page suppression
    chrome.tabs.query({}, (tabs) => {
      for (const t of tabs) {
        if (!t?.id || !t?.url) continue;
        try {
          const u = new URL(t.url);
          if (u.protocol === "http:" || u.protocol === "https:") {
            chrome.tabs.sendMessage(t.id, { type: "RULES_UPDATED" }, () => void chrome.runtime.lastError);
          }
        } catch { /* ignore */ }
      }

      // NEW: immediately re-evaluate and (if needed) open the router under the new policy
      forceReevaluateAndPrompt(tabs).catch(() => {});
    });
  }

  if (changes.customDomains) {
    // Recompute AI domains (custom + packaged)
    Promise.all([
      fetch(chrome.runtime.getURL("data/ai_domains.json")).then(r => r.json()),
      new Promise(res => chrome.storage.local.get(["customDomains"], v => res(v.customDomains || [])))
    ]).then(([packaged, custom]) => {
      aiDomainsCache = Array.from(new Set([...(custom || []), ...(packaged || [])]));
    }).catch(()=>{});
  }
});

// ------------------ Helpers ------------------
function getActiveProfileSync(rulesObj) {
  const selectedId = rulesObj?.selectedProfileId || "confirm";
  const profile = rulesObj?.profiles?.find(p => p.id === selectedId) || rulesObj?.profiles?.[0];
  return profile;
}

async function getActiveProfile() {
  if (!rulesCache) {
    const { rules } = await getLocal(["rules"]);
    rulesCache = rules || rulesCache;
  }
  return getActiveProfileSync(rulesCache);
}

function hostFromUrl(url){ try{ return new URL(url).hostname.toLowerCase(); }catch{ return ""; } }
function isHttpUrl(url){ try{ const u=new URL(url); return u.protocol==="http:"||u.protocol==="https:"; }catch{ return false; } }

// Normalize a list entry like "https://foo.bar/path" -> "foo.bar" and lowercase
function normalizeHostEntry(input) {
  try {
    if (typeof input !== "string") return "";
    const s = input.trim();
    if (!s) return "";
    if (s.includes("://")) return new URL(s).hostname.toLowerCase();
    return s.replace(/^\.+|\.+$/g, "").toLowerCase(); // strip leading/trailing dots
  } catch {
    return (input || "").toString().toLowerCase();
  }
}

// true if host === entry OR host endsWith("." + entry)
function hostMatchesEntry(host, entry) {
  const h = (host || "").toLowerCase();
  const e = normalizeHostEntry(entry);
  if (!h || !e) return false;
  return h === e || h.endsWith("." + e);
}

// suffix-aware membership
function isHostInList(host, list) {
  const h = (host || "").toLowerCase();
  const arr = Array.isArray(list) ? list : [];
  return arr.some(e => hostMatchesEntry(h, e));
}

function isAiDomainHost(host){
  // Reuse the same suffix logic for AI domains as well
  return isHostInList(host, aiDomainsCache);
}

function shouldOpenRouter(tabId, host) {
  if (tabId == null || !host) return false;
  const key = `${tabId}|${host}`;
  const now = Date.now();

  // Respect recent consent (Proceed)
  const consent = consentMap.get(key);
  if (consent && consent.allowedUntil > now) return false;

  // Anti-dup cooldown
  const last = lastOpenMap.get(key) || 0;
  if (now - last < OPEN_COOLDOWN_MS) return false;

  lastOpenMap.set(key, now);
  return true;
}

/**
 * Profile gating for router prompts:
 *  - "allow": only prompt if host is blocklisted
 *  - "confirm"/"strict": prompt as normal
 */
function shouldPromptForProfile(profile, { isBlocklisted }) {
  if (!profile) return true;
  if (profile.id === "allow") {
    return !!isBlocklisted; // silent unless blocklisted
  }
  return true;
}

/**
 * Safely send OPEN_ROUTER to a tab:
 *  - only http/https pages
 *  - retry once after 250ms if content script is not ready yet
 *  - swallow runtime errors to avoid crashing the SW
 */
async function safeOpenRouter(tabId, tabUrl, payload) {
  if (!tabUrl || !isHttpUrl(tabUrl)) return;

  async function attempt() {
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, payload, () => {
        const err = chrome.runtime.lastError;
        resolve({ ok: !err, error: err?.message });
      });
    });
  }

  // Attempt #1
  let res = await attempt();
  if (res.ok) return;

  // Retry once if receiver wasn't ready yet
  if (/Receiving end does not exist/i.test(res.error || "")) {
    await new Promise(r => setTimeout(r, 250));
    await attempt();
  }
}

// ------------------ Immediate re-eval after policy change ------------------
async function forceReevaluateAndPrompt(tabs) {
  const { rules } = await getLocal(["rules"]);
  if (rules) rulesCache = rules;
  const profile = getActiveProfileSync(rulesCache);

  for (const t of tabs) {
    try {
      if (!t?.id || !t?.url || !isHttpUrl(t.url)) continue;
      const host = hostFromUrl(t.url);
      if (!host || !isAiDomainHost(host)) continue;

      const allow = isHostInList(host, profile.allowList || []);
      const block = isHostInList(host, profile.blockList || []);
      if (allow) continue; // explicitly allowed -> no prompt

      const ctx = {
        isAiDomain: true,
        aiUiSignals: [],
        sensitiveFields: {},
        isInternalSite: isInternal(t.url),
        blocklisted: !!block
      };
      let risk = computeRiskScore(ctx, profile);
      if (block) risk = 100;

      const promptOk = shouldPromptForProfile(profile, { isBlocklisted: block });
      if (!promptOk) continue;

      // bypass cooldown/consent just-cleared? We still use shouldOpenRouter to avoid immediate dup if any
      if (!shouldOpenRouter(t.id, host)) continue;

      await safeOpenRouter(t.id, t.url, {
        type: "OPEN_ROUTER",
        reason: block ? "This site is blocked by policy" : "AI domain detected",
        context: ctx,
        risk,
        profileId: profile.id
      });

      await appendLog({
        kind: "policy_reprompt",
        tabUrl: t.url,
        risk,
        profileId: profile.id,
        host,
        triggeredBy: "RULES_UPDATED"
      });
    } catch { /* ignore this tab */ }
  }
}

// ------------------ Domain detection ------------------
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  try {
    if (changeInfo.status !== "complete" || !tab?.url) return;
    if (!isHttpUrl(tab.url)) return;
    if (!aiDomainsCache?.length) await ensureBoot();

    const host = hostFromUrl(tab.url);
    const isAi = isAiDomainHost(host);
    if (!isAi) return;

    const { rules } = await getLocal(["rules"]);
    if (rules) rulesCache = rules;
    const profile = getActiveProfileSync(rulesCache);

    const allow = isHostInList(host, profile.allowList || []);
    const block = isHostInList(host, profile.blockList || []);
    if (allow) return;

    const ctx = {
      isAiDomain: true,
      aiUiSignals: [],
      sensitiveFields: {},
      isInternalSite: isInternal(tab.url),
      blocklisted: !!block
    };
    let risk = computeRiskScore(ctx, profile);
    if (block) risk = 100; // Blocklist override in domain path

    const promptOk = shouldPromptForProfile(profile, { isBlocklisted: block });
    if (!promptOk) return;

    if (!shouldOpenRouter(tabId, host)) return;

    await safeOpenRouter(tabId, tab.url, {
      type: "OPEN_ROUTER",
      reason: block ? "This site is blocked by policy" : "AI domain detected",
      context: ctx,
      risk,
      profileId: profile.id
    });

    await appendLog({
      kind: "domain_detected",
      tabUrl: tab.url,
      risk,
      profileId: profile.id,
      host,
      blocked: !!block
    });
  } catch (e) {
    console.warn("[AIPG] onUpdated error:", e);
  }
});

// ------------------ Message hub ------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      // In‑page AI detection
      if (msg.type === "AI_UI_DETECTED") {
        const pageUrl = msg.pageUrl || sender?.tab?.url || "";
        if (!isHttpUrl(pageUrl)) { sendResponse?.({ ok:true, suppressed:true }); return; }

        const host = hostFromUrl(pageUrl);

        const { rules } = await getLocal(["rules"]);
        if (rules) rulesCache = rules;
        const profile = getActiveProfileSync(rulesCache);

        const allow = isHostInList(host, profile.allowList || []);
        const block = isHostInList(host, profile.blockList || []);

        if (allow) {
          await appendLog({ kind: "ui_detected_suppressed", pageUrl, host });
          sendResponse?.({ ok: true, suppressed: true });
          return;
        }

        const isAi = (typeof msg.isAiDomainFromContent === "boolean")
          ? msg.isAiDomainFromContent
          : isAiDomainHost(host);

        const ctx = {
          isAiDomain: isAi,
          aiUiSignals: msg.signals || [],
          sensitiveFields: msg.sensitiveFields || {},
          isInternalSite: isInternal(pageUrl),
          blocklisted: !!block
        };
        let risk = computeRiskScore(ctx, profile);
        if (block) risk = 100; // Blocklist override also in UI path

        const promptOk = shouldPromptForProfile(profile, { isBlocklisted: block });
        if (!promptOk) { sendResponse?.({ ok: true, suppressed: true }); return; }

        if (!shouldOpenRouter(sender?.tab?.id ?? -1, host)) {
          sendResponse?.({ ok: true, suppressed: true });
          return;
        }

        await safeOpenRouter(sender.tab.id, pageUrl, {
          type: "OPEN_ROUTER",
          reason: block ? "This site is blocked by policy" : "In‑app AI detected",
          context: ctx,
          risk,
          profileId: profile.id
        });

        await appendLog({
          kind: "ui_detected",
          pageUrl, host,
          signals: (msg.signals || []).slice(0, 5),
          sensitive: msg.sensitiveFields || {},
          risk, profileId: profile.id,
          blocklisted: !!block
        });

        sendResponse?.({ ok: true });
        return;
      }

      // Router decision (Proceed / Cancel)
      if (msg.type === "ROUTER_DECISION") {
        await appendLog({
          kind: "router_decision",
          decision: msg.decision,
          reason: msg.reason,
          tabUrl: msg.tabUrl,
          risk: msg.risk,
          profileId: msg.profileId,
          pinVerified: !!msg.pinVerified
        });

        // Grant consent window ONLY on Proceed
        if (msg.decision === "proceed") {
          const host = hostFromUrl(msg.tabUrl || "");
          if (host && sender?.tab?.id != null) {
            const key = `${sender.tab.id}|${host}`;
            const now = Date.now();
            consentMap.set(key, { allowedUntil: now + CONSENT_TTL_MS });
          }
        }

        sendResponse?.({ ok: true });
        return;
      }

      // Optional local prompt tracking
      if (msg.type === "PROMPT_ACTIVITY") {
        const pageUrl = msg.tabUrl || sender?.tab?.url || "";
        if (!isHttpUrl(pageUrl)) { sendResponse?.({ ok:true }); return; }

        const { rules } = await getLocal(["rules"]);
        if (rules) rulesCache = rules;
        const profile = getActiveProfileSync(rulesCache);
        const mode = profile.trackPrompts || "off";

        const entry = { kind: "prompt", mode, pageUrl, length: msg.text ? msg.text.length : 0 };
        if (mode === "anonymized" && msg.text) entry.hash = await sha256(msg.text);
        else if (mode === "full" && msg.text) entry.text = String(msg.text).slice(0, 2000);

        await appendLog(entry);
        sendResponse?.({ ok: true });
        return;
      }

      // Directory / options helpers
      if (msg.type === "REQUEST_AI_DOMAINS") {
        if (!aiDomainsCache?.length) await ensureBoot();
        sendResponse?.({ domains: aiDomainsCache });
        return;
      }

      if (msg.type === "GET_PROFILE") {
        const { rules } = await getLocal(["rules"]);
        if (rules) rulesCache = rules;
        const profile = getActiveProfileSync(rulesCache);
        sendResponse?.({ profile });
        return;
      }

    } catch (e) {
      console.warn("[AIPG] onMessage error:", e);
      sendResponse?.({ ok: false, error: String(e) });
    }
  })();

  return true; // async response
});