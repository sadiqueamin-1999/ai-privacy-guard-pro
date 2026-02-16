// utils.js (classic, guarded assignments)
(function(){
  self.AIPG = self.AIPG || {};

  if (!self.AIPG.getOrCreateUserId) {
    self.AIPG.getOrCreateUserId = function getOrCreateUserId() {
      return new Promise(resolve => {
        chrome.storage.local.get(["userId"], (res) => {
          if (res.userId) return resolve(res.userId);
          const id = crypto.randomUUID();
          chrome.storage.local.set({ userId: id }, () => resolve(id));
        });
      });
    };
  }

  if (!self.AIPG.sha256) {
    self.AIPG.sha256 = function sha256(text) {
      const enc = new TextEncoder().encode(text);
      return crypto.subtle.digest("SHA-256", enc).then((buf) => {
        return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
      });
    };
  }

  if (!self.AIPG.loadJson) {
    self.AIPG.loadJson = function loadJson(path) {
      const url = chrome.runtime.getURL(path);
      return fetch(url).then(r => r.json());
    };
  }

  if (!self.AIPG.getLocal) {
    self.AIPG.getLocal = function getLocal(keys) {
      return new Promise(resolve => chrome.storage.local.get(keys, resolve));
    };
  }

  if (!self.AIPG.setLocal) {
    self.AIPG.setLocal = function setLocal(obj) {
      return new Promise(resolve => chrome.storage.local.set(obj, resolve));
    };
  }

  if (!self.AIPG.computeRiskScore) {
    self.AIPG.computeRiskScore = function computeRiskScore(ctx, profile) {
      const sw = profile.sensitiveFieldWeights || {};
      const aiOnPageW = profile.aiOnPageWeight || 0;
      const aiDomainW = profile.aiDomainWeight || 0;
      const internalW = profile.internalSiteWeight || 0;

      let score = 0;
      if (ctx.isAiDomain) score += aiDomainW;
      if (ctx.aiUiSignals && ctx.aiUiSignals.length > 0) score += aiOnPageW;
      if (ctx.isInternalSite) score += internalW;

      for (const k of ["password","email","credit","id"]) {
        const present = ctx.sensitiveFields?.[k] || 0;
        if (present > 0) score += (sw[k] || 0);
      }
      return Math.min(100, score);
    };
  }

  if (!self.AIPG.isInternal) {
    self.AIPG.isInternal = function isInternal(url) {
      try {
        const u = new URL(url);
        return /\b(corp|intranet|internal)\b/.test(u.hostname) || /\.local\b/.test(u.hostname);
      } catch { return false; }
    };
  }

  // UPDATED: include userRole + userId with every log entry (metadata-only)
  if (!self.AIPG.appendLog) {
    self.AIPG.appendLog = function appendLog(entry) {
      const now = new Date().toISOString();
      return self.AIPG.getLocal(["logs", "userRole", "userId"]).then(async ({ logs = [], userRole, userId }) => {
        // Ensure userId exists
        if (!userId) userId = await self.AIPG.getOrCreateUserId();
        const payload = { ts: now, userRole: userRole || "", userId: userId || "", ...entry };
        logs.push(payload);
        return self.AIPG.setLocal({ logs });
      });
    };
  }
})();