// ChatQueue AI — Popup Script

const $ = id => document.getElementById(id);

// ── Tab switching ─────────────────────────────────────────────────────
document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
    tab.classList.add("active");
    $(`tab-${tab.dataset.tab}`).classList.add("active");
    if (tab.dataset.tab === "status") renderStatus();
    if (tab.dataset.tab === "log") renderLog();
    if (tab.dataset.tab === "settings") renderSettings();
  });
});

const ALLOWED_DOMAINS = ["claude.ai", "chatgpt.com", "gemini.google.com", "deepseek.com"];

function getDomainName(url) {
  try {
    const hostname = new URL(url).hostname;
    if (hostname.includes("claude.ai")) return "Claude";
    if (hostname.includes("chatgpt.com")) return "ChatGPT";
    if (hostname.includes("gemini.google.com")) return "Gemini";
    if (hostname.includes("deepseek.com")) return "DeepSeek";
  } catch {}
  return "";
}

// ── Use current tab button ────────────────────────────────────────────
$("btnCurrentTab").addEventListener("click", () => {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const tab = tabs[0];
    if (tab && tab.url) {
      const name = getDomainName(tab.url);
      if (name) {
        $("chatUrl").value = tab.url;
        updatePlatformBadge();
        saveDraft();
        toast(`✓ ${name} URL captured`);
        return;
      }
    }
    toast("Open a supported AI chat first");
  });
});

// ── Start ─────────────────────────────────────────────────────────────
$("btnStart").addEventListener("click", () => {
  const chatUrl      = $("chatUrl").value.trim();
  const prompt       = $("prompt").value.trim();
  const resetMinutes = parseInt($("resetMinutes").value) || 0;
  const checkInterval = parseInt($("checkInterval").value) || 60;

  const isValid = ALLOWED_DOMAINS.some(domain => {
    try {
      const parsed = new URL(chatUrl);
      return parsed.hostname.includes(domain) && chatUrl.startsWith("https://");
    } catch {
      return false;
    }
  });

  if (!isValid) {
    toast("⚠ Enter a valid AI chat URL"); return;
  }
  if (!prompt) {
    toast("⚠ Enter a resume prompt"); return;
  }

  // Save settings for persistence
  chrome.storage.local.set({ savedSettings: { chatUrl, prompt, resetMinutes, checkInterval } });

  // Add to prompt history
  chrome.storage.local.get("promptHistory", d => {
    let history = d.promptHistory || [];
    const domain = getDomainName(chatUrl);
    history = history.filter(h => h.prompt !== prompt);
    history.unshift({ prompt, timestamp: Date.now(), domain });
    if (history.length > 15) history.pop();
    chrome.storage.local.set({ promptHistory: history });
  });

  chrome.runtime.sendMessage({
    type: "START_RESUME",
    data: { chatUrl, prompt, resetMinutes, checkInterval }
  }, () => {
    toast("✓ ChatQueue AI started!");
    updateUI();
    // Switch to status tab
    setTimeout(() => {
      document.querySelector('[data-tab="status"]').click();
    }, 600);
  });
});

// ── Stop ──────────────────────────────────────────────────────────────
$("btnStop").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "STOP_RESUME" }, () => {
    toast("Stopped");
    updateUI();
  });
});

// ── Render status tab ─────────────────────────────────────────────────
function renderStatus() {
  chrome.runtime.sendMessage({ type: "GET_STATUS" }, resp => {
    const state = resp?.state;
    const el = $("statusContent");

    if (!state || (!state.active && state.status !== "done" && state.status !== "failed")) {
      el.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🕒</div>
          <div class="empty-text">No active session.<br>Go to Setup and click Start.</div>
        </div>`;
      return;
    }

    const statusChip = {
      monitoring: `<span class="chip green">● Monitoring</span>`,
      waiting:    `<span class="chip yellow">● Waiting</span>`,
      checking:   `<span class="chip blue">● Checking</span>`,
      sending:    `<span class="chip blue">● Sending</span>`,
      done:       `<span class="chip green">✓ Done</span>`,
      failed:     `<span class="chip red">✗ Failed</span>`,
      stopped:    `<span class="chip gray">■ Stopped</span>`,
    }[state.status] || `<span class="chip gray">${state.status}</span>`;

    // Progress calculation
    let progress = 0;
    let progressLabel = "";
    if (state.limitDetectedAt && state.status === "waiting") {
      const elapsed = (Date.now() - state.limitDetectedAt) / 60000;
      progress = state.resetMinutes > 0
        ? Math.min(95, (elapsed / state.resetMinutes) * 100)
        : 95;
      const remaining = Math.max(0, state.resetMinutes - elapsed);
      progressLabel = `${Math.ceil(remaining)} min remaining`;
    } else if (state.status === "done") {
      progress = 100;
      progressLabel = "Complete";
    } else if (state.status === "monitoring") {
      progressLabel = "Watching for usage limit...";
    } else if (state.status === "checking") {
      progressLabel = "Checking if limit has reset...";
    }

    // Chat URL display
    const urlShort = state.chatUrl
      ? ".../" + state.chatUrl.split("/").pop().slice(0, 16) + "..."
      : "—";

    // Elapsed time
    const elapsedMin = state.startedAt
      ? Math.floor((Date.now() - state.startedAt) / 60000)
      : 0;

    el.innerHTML = `
      <div class="status-card">
        <div class="status-row">
          <span class="status-label">Status</span>
          ${statusChip}
        </div>
        <div class="status-row">
          <span class="status-label">Chat</span>
          <span class="status-value" title="${state.chatUrl}">${urlShort}</span>
        </div>
        <div class="status-row">
          <span class="status-label">Attempts</span>
          <span class="status-value">${state.attempts || 0}</span>
        </div>
        <div class="status-row" style="margin-bottom:0">
          <span class="status-label">Running for</span>
          <span class="status-value">${elapsedMin < 60 ? elapsedMin + " min" : Math.floor(elapsedMin/60) + "h " + (elapsedMin%60) + "m"}</span>
        </div>
        ${progressLabel ? `
        <div class="progress-bar" style="margin-top:12px">
          <div class="progress-fill" style="width:${progress}%"></div>
        </div>
        <div style="font-size:10px;color:var(--muted);margin-top:6px;font-family:'DM Mono',monospace;">
          ${progressLabel}
        </div>` : ""}
      </div>

      <div class="status-card">
        <div class="status-row">
          <span class="status-label">Session</span>
          <span class="status-value" id="statusSession">—</span>
        </div>
        <div class="status-row" style="margin-bottom:0">
          <span class="status-label">Weekly</span>
          <span class="status-value" id="statusWeekly">—</span>
        </div>
      </div>

      <div class="status-card">
        <div class="status-label" style="margin-bottom:8px">Resume Prompt</div>
        <div style="font-size:12px;color:var(--text);line-height:1.6;word-break:break-word;">
          ${escHtml(state.prompt || "—")}
        </div>
      </div>

      ${state.active ? `<button class="btn-stop" id="btnStop2">■ Stop ChatQueue AI</button>` : ""}
    `;

    // Re-attach stop button
    const stop2 = $("btnStop2");
    if (stop2) stop2.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "STOP_RESUME" }, () => {
        toast("Stopped"); updateUI(); renderStatus();
      });
    });

    // Fetch live usage from the active tab if it matches
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      let tab = tabs && tabs[0];
      let hasUsage = false;
      if (tab && tab.url && ALLOWED_DOMAINS.some(d => tab.url.includes(d))) {
        fetchUsage(tab.id);
        hasUsage = true;
      }

      if (!hasUsage && state.chatUrl) {
        try {
          const host = new URL(state.chatUrl).hostname;
          chrome.tabs.query({ url: `*://${host}/*` }, allTabs => {
            const fallbackTab = allTabs && allTabs[0];
            if (fallbackTab) fetchUsage(fallbackTab.id);
          });
        } catch {}
      }
    });

    function fetchUsage(tabId) {
      chrome.tabs.sendMessage(tabId, { type: "GET_USAGE_INFO" }, usage => {
        if (chrome.runtime.lastError || !usage) return;

        const sessionEl = $("statusSession");
        const weeklyEl  = $("statusWeekly");

        if (sessionEl && usage.session) {
          const pct = usage.session.pct;
          let color = "var(--green)";
          if (pct >= 100) color = "var(--red)";
          else if (pct >= 80) color = "var(--yellow)";
          const resetTxt = usage.session.reset ? ` · resets in ${usage.session.reset.display}` : "";
          sessionEl.innerHTML = `<span style="color:${color};font-weight:500">${pct}%</span>${resetTxt}`;
        }

        if (weeklyEl && usage.weekly) {
          const pct = usage.weekly.pct;
          let color = "var(--muted)";
          if (pct >= 80) color = "var(--yellow)";
          const resetTxt = usage.weekly.reset ? ` · resets in ${usage.weekly.reset.display}` : "";
          weeklyEl.innerHTML = `<span style="color:${color};font-weight:500">${pct}%</span>${resetTxt}`;
        }
      });
    }
  });
}

// ── Render log tab ────────────────────────────────────────────────────
function renderLog() {
  chrome.runtime.sendMessage({ type: "GET_STATUS" }, resp => {
    const state = resp?.state;
    const box = $("logBox");
    if (!state || !state.log || state.log.length === 0) {
      box.innerHTML = `<span class="log-line">No log entries yet.</span>`;
      return;
    }

    box.innerHTML = state.log.map(line => {
      let cls = "";
      if (line.includes("✓") || line.includes("sent") || line.includes("Success")) cls = "success";
      else if (line.includes("⚠") || line.includes("Wait") || line.includes("Waiting")) cls = "warn";
      else if (line.includes("Checking") || line.includes("Attempt") || line.includes("Check")) cls = "info";
      else if (line.includes("✗") || line.includes("Failed") || line.includes("Error")) cls = "error";
      return `<span class="log-line ${cls}">${escHtml(line)}</span>`;
    }).join("\n");

    // Scroll to bottom
    box.scrollTop = box.scrollHeight;
  });
}

// ── Update overall UI state ───────────────────────────────────────────
function updateUI() {
  chrome.runtime.sendMessage({ type: "GET_STATUS" }, resp => {
    const state = resp?.state;
    const pill    = document.querySelector(".status-pill");
    const pillTxt = $("headerPillText");
    const btnStart = $("btnStart");
    const btnStop  = $("btnStop");

    if (!state || !state.active) {
      pill.className = "status-pill idle";
      pillTxt.textContent = "Idle";
      btnStart.style.display = "block";
      btnStop.style.display = "none";
      btnStart.disabled = false;
    } else {
      pill.className = `status-pill ${state.status === "waiting" ? "waiting"
                       : state.status === "checking" || state.status === "sending" ? "checking"
                       : state.status === "done" ? "done"
                       : "active"}`;
      const labels = {
        monitoring: "Monitoring",
        waiting:    "Waiting",
        checking:   "Checking",
        sending:    "Sending",
        done:       "Done",
      };
      pillTxt.textContent = labels[state.status] || state.status;
      btnStart.style.display = "none";
      btnStop.style.display = "block";
    }
  });
}

// ── Toast notification ────────────────────────────────────────────────
let toastTimer = null;
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
}

function escHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ── Token estimation ──────────────────────────────────────────────────
function estimateTokens(text) {
  if (!text) return 0;
  const charCount = text.length;
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  if (charCount === 0) return 0;
  const tokens = Math.ceil((charCount / 4 + wordCount / 0.75) / 2);
  return Math.max(1, tokens);
}

function updatePromptStats() {
  const text = $("prompt").value;
  const chars = text.length;
  const tokens = estimateTokens(text);
  $("promptCharCount").textContent = chars + " chars";
  $("promptTokenCount").textContent = tokens + " tokens";
}

// ── Prompt Templates Storage & Rendering ──────────────────────────────
const BUILTIN_TEMPLATES = [
  { name: "Continue coding", prompt: "Continue coding from where we left off. Pick up the next task and implement it." },
  { name: "Summarize progress", prompt: "Summarize our progress so far and outline the remaining tasks." },
  { name: "Debug the error", prompt: "Debug the last error we encountered. Analyze the issue and provide a fix." },
  { name: "Continue from where we left off", prompt: "Continue from where we left off. Next step:" }
];

function getTemplates(cb) {
  chrome.storage.local.get("customTemplates", d => {
    const custom = d?.customTemplates || [];
    cb([...BUILTIN_TEMPLATES, ...custom]);
  });
}

function saveCustomTemplate(name, prompt) {
  chrome.storage.local.get("customTemplates", d => {
    const arr = d?.customTemplates || [];
    arr.push({ name, prompt, custom: true });
    if (arr.length > 10) arr.shift();
    chrome.storage.local.set({ customTemplates: arr }, () => {
      renderTemplates();
    });
  });
}

function removeCustomTemplate(idx) {
  chrome.storage.local.get("customTemplates", d => {
    const arr = d?.customTemplates || [];
    arr.splice(idx, 1);
    chrome.storage.local.set({ customTemplates: arr }, () => {
      renderTemplates();
    });
  });
}

function renderTemplates() {
  const container = $("templateChips");
  if (!container) return;
  getTemplates(templates => {
    container.innerHTML = templates.map((t, i) => {
      if (t.custom) {
        return `<span class="template-chip custom" data-idx="${i}" title="${escHtml(t.prompt)}" style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;">
          <span>${escHtml(t.name)}</span>
          <span class="template-chip-del" data-idx="${i}" title="Delete template">✕</span>
        </span>`;
      } else {
        return `<span class="template-chip" data-idx="${i}" title="${escHtml(t.prompt)}">${escHtml(t.name)}</span>`;
      }
    }).join("");

    container.querySelectorAll(".template-chip").forEach(chip => {
      chip.onclick = (e) => {
        if (e.target.classList.contains("template-chip-del")) {
          e.stopPropagation();
          const idx = parseInt(e.target.dataset.idx);
          const customIdx = idx - BUILTIN_TEMPLATES.length;
          removeCustomTemplate(customIdx);
          toast("✓ Template deleted");
          return;
        }
        const idx = parseInt(chip.dataset.idx);
        const tpl = templates[idx];
        if (tpl) {
          $("prompt").value = tpl.prompt;
          updatePromptStats();
          $("prompt").focus();
        }
      };
    });
  });
}

// ── Debounced Draft Auto-saving ──────────────────────────────────────
let popupSaveTimeout = null;
function saveDraft() {
  clearTimeout(popupSaveTimeout);
  popupSaveTimeout = setTimeout(() => {
    const chatUrl = $("chatUrl").value;
    const prompt = $("prompt").value;
    const resetMinutes = parseInt($("resetMinutes").value) || 0;
    const checkInterval = parseInt($("checkInterval").value) || 60;
    chrome.storage.local.set({ savedSettings: { chatUrl, prompt, resetMinutes, checkInterval } });
  }, 400);
}

// ── Sync Composer Text ───────────────────────────────────────────────
function requestComposerText() {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const tab = tabs[0];
    if (!tab || !tab.url || !ALLOWED_DOMAINS.some(d => tab.url.includes(d))) {
      toast("Open a supported AI chat first");
      return;
    }
    chrome.tabs.sendMessage(tab.id, { type: "GET_COMPOSER_TEXT" }, resp => {
      if (chrome.runtime.lastError || !resp) {
        toast("⚠ Could not read AI input box");
        return;
      }
      if (resp.text) {
        $("prompt").value = resp.text;
        updatePromptStats();
        saveDraft();
        toast("✓ Synced from AI chat box");
      } else {
        toast("ℹ AI chat box is empty");
      }
    });
  });
}

// ── Update active platform badge ──────────────────────────────────────
function updatePlatformBadge() {
  const url = $("chatUrl").value;
  const name = getDomainName(url);
  const badge = $("activePlatformBadge");
  if (!badge) return;

  if (name === "Claude") {
    badge.textContent = "🟠 Claude";
    badge.style.cssText = "font-weight: 600; padding: 2px 8px; border-radius: 4px; font-size: 9px; background: rgba(249, 115, 22, 0.1); border: 1px solid rgba(249, 115, 22, 0.35); color: #f97316; letter-spacing: 0.3px;";
  } else if (name === "ChatGPT") {
    badge.textContent = "🟢 ChatGPT";
    badge.style.cssText = "font-weight: 600; padding: 2px 8px; border-radius: 4px; font-size: 9px; background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.35); color: #10b981; letter-spacing: 0.3px;";
  } else if (name === "Gemini") {
    badge.textContent = "🔵 Gemini";
    badge.style.cssText = "font-weight: 600; padding: 2px 8px; border-radius: 4px; font-size: 9px; background: rgba(59, 130, 246, 0.1); border: 1px solid rgba(59, 130, 246, 0.35); color: #3b82f6; letter-spacing: 0.3px;";
  } else if (name === "DeepSeek") {
    badge.textContent = "🟣 DeepSeek";
    badge.style.cssText = "font-weight: 600; padding: 2px 8px; border-radius: 4px; font-size: 9px; background: rgba(139, 92, 246, 0.1); border: 1px solid rgba(139, 92, 246, 0.35); color: #8b5cf6; letter-spacing: 0.3px;";
  } else {
    badge.textContent = "None";
    badge.style.cssText = "font-weight: 600; padding: 2px 8px; border-radius: 4px; font-size: 9px; background: rgba(255, 255, 255, 0.05); border: 1px solid var(--border); color: var(--muted); letter-spacing: 0.3px;";
  }
}

// ── Broadcaster for setting updates ──────────────────────────────────
function updateSetting(key, val) {
  chrome.storage.local.set({ [key]: val }, () => {
    chrome.tabs.query({}, tabs => {
      tabs.forEach(tab => {
        if (tab.url && ALLOWED_DOMAINS.some(d => tab.url.includes(d))) {
          chrome.tabs.sendMessage(tab.id, { type: "SETTING_CHANGED", key, val }, () => chrome.runtime.lastError);
        }
      });
    });
  });
}

// ── Render settings panel ─────────────────────────────────────────────
function renderSettings() {
  chrome.storage.local.get(["soundEnabled", "fabEnabled", "autoCaptureEnabled", "promptHistory"], d => {
    $("chkSound").checked = d.soundEnabled !== false;
    $("chkFab").checked = d.fabEnabled !== false;
    $("chkAutoCapture").checked = d.autoCaptureEnabled !== false;

    // Render history
    const history = d.promptHistory || [];
    const list = $("promptHistoryList");
    if (history.length === 0) {
      list.innerHTML = `
        <div class="empty-state" style="padding: 10px; font-size: 11px;">
          <div class="empty-text">No prompt history yet.</div>
        </div>
      `;
      return;
    }

    list.innerHTML = history.map((item, idx) => {
      const date = new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const brand = item.domain || "AI";
      return `
        <div class="history-item" data-idx="${idx}">
          <div class="history-text" title="${escHtml(item.prompt)}">${escHtml(item.prompt)}</div>
          <div style="display: flex; align-items: center; gap: 6px; flex-shrink: 0;">
            <span style="font-size: 8px; font-weight: 600; padding: 1px 4px; border-radius: 3px; background: rgba(255,255,255,0.06); border: 1px solid var(--border);">${brand}</span>
            <span class="history-date">${date}</span>
          </div>
        </div>
      `;
    }).join("");

    // Bind click listeners to history items
    list.querySelectorAll(".history-item").forEach(item => {
      item.onclick = () => {
        const idx = parseInt(item.dataset.idx);
        const selected = history[idx];
        if (selected) {
          $("prompt").value = selected.prompt;
          updatePromptStats();
          saveDraft();
          toast("✓ Prompt loaded from history");
          // Switch back to setup tab
          document.querySelector('[data-tab="setup"]').click();
        }
      };
    });
  });
}

// ── Load saved settings on open ───────────────────────────────────────
chrome.storage.local.get(["savedSettings", "autoCaptureEnabled"], ({ savedSettings, autoCaptureEnabled }) => {
  if (savedSettings) {
    if (savedSettings.chatUrl)      $("chatUrl").value      = savedSettings.chatUrl;
    if (savedSettings.prompt)       $("prompt").value       = savedSettings.prompt;
    if (savedSettings.resetMinutes) $("resetMinutes").value = savedSettings.resetMinutes;
    if (savedSettings.checkInterval) $("checkInterval").value = savedSettings.checkInterval;
    updatePromptStats();
    updatePlatformBadge();
  }
  
  // If the prompt is still empty, auto-detect composer text
  if (autoCaptureEnabled !== false && !$("prompt").value.trim()) {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      const tab = tabs[0];
      if (tab && tab.url && ALLOWED_DOMAINS.some(d => tab.url.includes(d))) {
        chrome.tabs.sendMessage(tab.id, { type: "GET_COMPOSER_TEXT" }, resp => {
          if (!chrome.runtime.lastError && resp && resp.text) {
            $("prompt").value = resp.text;
            updatePromptStats();
            saveDraft();
          }
        });
      }
    });
  }
});

// ── Auto-detect timer from active Claude tab ─────────────────────────
function autoDetectTimer() {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const tab = tabs[0];
    if (!tab || !tab.url || !ALLOWED_DOMAINS.some(d => tab.url.includes(d))) return;
    chrome.tabs.sendMessage(tab.id, { type: "GET_RESET_INFO" }, resp => {
      if (chrome.runtime.lastError || !resp) return;
      if (resp.mins) {
        $("resetMinutes").value = resp.mins;
        const hint = document.querySelector(".time-hint");
        if (hint) hint.textContent = `Auto-detected: ${resp.display}`;
        hint?.classList?.add("green");
      }
    });
  });
}

// ── Init ──────────────────────────────────────────────────────────────
updateUI();
autoDetectTimer();
renderTemplates();

// ── Event Listeners ───────────────────────────────────────────────────
$("prompt").addEventListener("input", () => {
  updatePromptStats();
  saveDraft();
});
$("chatUrl").addEventListener("input", () => {
  updatePlatformBadge();
  saveDraft();
});
$("resetMinutes").addEventListener("input", saveDraft);
$("checkInterval").addEventListener("input", saveDraft);
$("btnSyncComposer").addEventListener("click", requestComposerText);

// Settings Toggles
$("chkSound").addEventListener("change", () => {
  updateSetting("soundEnabled", $("chkSound").checked);
  toast("✓ Sound alerts " + ($("chkSound").checked ? "enabled" : "disabled"));
});
$("chkFab").addEventListener("change", () => {
  updateSetting("fabEnabled", $("chkFab").checked);
  toast("✓ Floating badge " + ($("chkFab").checked ? "enabled" : "disabled"));
});
$("chkAutoCapture").addEventListener("change", () => {
  updateSetting("autoCaptureEnabled", $("chkAutoCapture").checked);
  toast("✓ Auto-capture " + ($("chkAutoCapture").checked ? "enabled" : "disabled"));
});
$("btnClearHistory").addEventListener("click", () => {
  chrome.storage.local.set({
    promptHistory: [],
    soundEnabled: true,
    fabEnabled: true,
    autoCaptureEnabled: true
  }, () => {
    updateSetting("soundEnabled", true);
    updateSetting("fabEnabled", true);
    updateSetting("autoCaptureEnabled", true);
    renderSettings();
    toast("🗑 History and settings cleared");
  });
});

// ── Save as template click handler ────────────────────────────────────
$("btnSaveTemplate").addEventListener("click", () => {
  const text = $("prompt").value.trim();
  if (!text) { toast("⚠ Enter a prompt first"); return; }
  const name = text.slice(0, 20).replace(/[^a-zA-Z0-9 ]/g, "") + (text.length > 20 ? "…" : "");
  saveCustomTemplate(name, text);
  toast("✓ Saved as template");
});

// Auto-refresh status every 5 seconds when popup is open
setInterval(() => {
  const activeTab = document.querySelector(".tab.active");
  if (activeTab?.dataset.tab === "status") renderStatus();
  if (activeTab?.dataset.tab === "log") renderLog();
  if (activeTab?.dataset.tab === "settings") renderSettings();
  updateUI();
}, 5000);
