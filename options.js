// options.js
(async function () {
  // --- storage helpers (return the value directly) ---
  function get(key) {
    return new Promise((res) => chrome.storage.local.get([key], (v) => res(v[key])));
  }
  function set(obj) {
    return new Promise((res) => chrome.storage.local.set(obj, res));
  }

  // --- load rules or defaults on first run ---
  const rules = (await get("rules")) || (await loadDefaults());
  const profiles = rules.profiles || [];
  const $ = (s) => document.querySelector(s);

  // ----- populate profile selector -----
  const sel = $("#profileSelect");
  profiles.forEach((p) => {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = `${p.name}`;
    sel.appendChild(opt);
  });
  sel.value = rules.selectedProfileId || (profiles[0] && profiles[0].id) || "";

  // ----- PIN & tracking modes -----
  $("#adminPin").value = rules.adminPin || "";
  const active = profiles.find((p) => p.id === sel.value) || profiles[0] || {};
  $("#trackUsers").value = active.trackUsers || "off";
  $("#trackPrompts").value = active.trackPrompts || "off";

  // NEW: Approved AI URL + User Role
  $("#approvedAiUrl").value = (await get("approvedAiUrl")) || "";
  $("#userRole").value = (await get("userRole")) || "";

  renderLists(active);

  $("#saveProfile").onclick = async () => {
    rules.selectedProfileId = sel.value;
    rules.adminPin = $("#adminPin").value;

    const idx = profiles.findIndex((p) => p.id === sel.value);
    if (idx >= 0) {
      profiles[idx].trackUsers = $("#trackUsers").value;
      profiles[idx].trackPrompts = $("#trackPrompts").value;
    }
    await set({ rules });

    // Also persist Approved AI URL & Role
    const approved = ($("#approvedAiUrl").value || "").trim();
    await set({ approvedAiUrl: approved });
    const role = $("#userRole").value || "";
    await set({ userRole: role });

    // Broadcast change is handled by background (storage.onChanged)
    alert("Saved.");
  };

  $("#addAllow").onclick = () => addHost("allow");
  $("#addBlock").onclick = () => addHost("block");

  $("#exportLogs").onclick = exportLogs;
  $("#clearLogs").onclick = async () => {
    await set({ logs: [] }); alert("Logs cleared.");
  };

  $("#openDirectory").onclick = () => window.open("directory.html");

  function renderLists(profile) {
    renderList(profile.allowList || [], "#allowList", "allow");
    renderList(profile.blockList || [], "#blockList", "block");
  }

  function renderList(arr, ulSel, kind) {
    const ul = document.querySelector(ulSel);
    ul.innerHTML = "";
    arr.forEach((host, i) => {
      const li = document.createElement("li");
      li.innerHTML = `<span>${host}</span><button data-i="${i}" data-kind="${kind}">Remove</button>`;
      ul.appendChild(li);
    });
    ul.querySelectorAll("button").forEach(btn => {
      btn.onclick = async () => {
        const i = +btn.dataset.i;
        const k = btn.dataset.kind;
        const idx = profiles.findIndex(p => p.id === sel.value);
        if (idx >= 0) {
          const list = k === "allow" ? (profiles[idx].allowList = profiles[idx].allowList || []) :
                                       (profiles[idx].blockList = profiles[idx].blockList || []);
          list.splice(i, 1);
          await set({ rules });
          renderLists(profiles[idx]);
        }
      };
    });
  }

  async function addHost(kind) {
    const input = kind === "allow" ? $("#allowInput") : $("#blockInput");
    const host = (input.value || "").trim();
    if (!host) return;
    const idx = profiles.findIndex(p => p.id === sel.value);
    if (idx >= 0) {
      const list = kind === "allow" ? (profiles[idx].allowList = profiles[idx].allowList || []) :
                                      (profiles[idx].blockList = profiles[idx].blockList || []);
      if (!list.includes(host)) list.push(host);
      await set({ rules });
      renderLists(profiles[idx]);
      input.value = "";
    }
  }

  async function exportLogs() {
    const logs = (await get("logs")) || []; // SAFE: get returns value, not object
    const blob = new Blob([JSON.stringify(logs, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "aipg-logs.json"; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  async function loadDefaults() {
    const r = await fetch(chrome.runtime.getURL("data/default_rules.json")).then((r) => r.json());
    await set({ rules: r });
    return r;
  }
})();