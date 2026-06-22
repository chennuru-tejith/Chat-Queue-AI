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
  const chatUrl = $("chatUrl").value.trim();
  chrome.runtime.sendMessage({ type: "STOP_RESUME", chatUrl }, () => {
    toast("Stopped");
    updateUI();
  });
});

// ── Render status tab ─────────────────────────────────────────────────
function renderStatus() {
  chrome.runtime.sendMessage({ type: "GET_STATUS" }, resp => {
    const queues = resp?.queues || {};
    const el = $("statusContent");

    const queueList = Object.values(queues);
    if (queueList.length === 0) {
      el.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🕒</div>
          <div class="empty-text">No active session.<br>Go to Setup and click Start.</div>
        </div>`;
      return;
    }

    // Sort queueList: active first, then by startedAt descending
    queueList.sort((a, b) => {
      if (a.active && !b.active) return -1;
      if (!a.active && b.active) return 1;
      return (b.startedAt || 0) - (a.startedAt || 0);
    });

    let html = "";
    queueList.forEach(q => {
      const statusChip = {
        monitoring: `<span class="chip green">● Monitoring</span>`,
        waiting:    `<span class="chip yellow">● Waiting</span>`,
        checking:   `<span class="chip blue">● Checking</span>`,
        sending:    `<span class="chip blue">● Sending</span>`,
        done:       `<span class="chip green">✓ Done</span>`,
        failed:     `<span class="chip red">✗ Failed</span>`,
        stopped:    `<span class="chip gray">■ Stopped</span>`,
      }[q.status] || `<span class="chip gray">${q.status}</span>`;

      // Progress calculation
      let progress = 0;
      let progressLabel = "";
      if (q.limitDetectedAt && q.status === "waiting") {
        const elapsed = (Date.now() - q.limitDetectedAt) / 60000;
        progress = q.resetMinutes > 0
          ? Math.min(95, (elapsed / q.resetMinutes) * 100)
          : 95;
        const remaining = Math.max(0, q.resetMinutes - elapsed);
        progressLabel = `${Math.ceil(remaining)} min remaining`;
      } else if (q.status === "done") {
        progress = 100;
        progressLabel = "Complete";
      } else if (q.status === "monitoring") {
        progressLabel = "Watching for usage limit...";
      } else if (q.status === "checking") {
        progressLabel = "Checking if limit has reset...";
      }

      // Platform badge
      const platformName = getDomainName(q.chatUrl);
      let platformBadge = `<span class="chip gray">${platformName || "AI"}</span>`;
      if (platformName === "Claude") {
        platformBadge = `<span class="chip" style="background: rgba(249, 115, 22, 0.1); border: 1px solid rgba(249, 115, 22, 0.3); color: #f97316;">🟠 Claude</span>`;
      } else if (platformName === "ChatGPT") {
        platformBadge = `<span class="chip" style="background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.3); color: #10b981;">🟢 ChatGPT</span>`;
      } else if (platformName === "Gemini") {
        platformBadge = `<span class="chip" style="background: rgba(59, 130, 246, 0.1); border: 1px solid rgba(59, 130, 246, 0.3); color: #3b82f6;">🔵 Gemini</span>`;
      } else if (platformName === "DeepSeek") {
        platformBadge = `<span class="chip" style="background: rgba(139, 92, 246, 0.1); border: 1px solid rgba(139, 92, 246, 0.3); color: #8b5cf6;">🟣 DeepSeek</span>`;
      }

      // Chat URL display
      const urlShort = q.chatUrl
        ? ".../" + q.chatUrl.split("/").pop().slice(0, 20) + "..."
        : "—";

      // Elapsed time
      const elapsedMin = q.startedAt
        ? Math.floor((Date.now() - q.startedAt) / 60000)
        : 0;
      const runningTime = elapsedMin < 60 ? elapsedMin + " min" : Math.floor(elapsedMin/60) + "h " + (elapsedMin%60) + "m";

      html += `
        <div class="status-card" style="border-left: 3px solid ${q.active ? 'var(--accent)' : 'var(--border)'}; margin-bottom: 16px;">
          <div class="status-row">
            ${platformBadge}
            ${statusChip}
          </div>
          <div class="status-row" style="margin-top: 8px;">
            <span class="status-label">Chat</span>
            <span class="status-value" title="${q.chatUrl}"><a href="${q.chatUrl}" target="_blank" style="color: var(--blue); text-decoration: none;">${urlShort}</a></span>
          </div>
          <div class="status-row">
            <span class="status-label">Attempts</span>
            <span class="status-value">${q.attempts || 0}</span>
          </div>
          <div class="status-row">
            <span class="status-label">Running for</span>
            <span class="status-value">${runningTime}</span>
          </div>
          ${progressLabel ? `
          <div class="progress-bar" style="margin-top:8px">
            <div class="progress-fill" style="width:${progress}%"></div>
          </div>
          <div style="font-size:10px;color:var(--muted);margin-top:4px;font-family:'DM Mono',monospace;display:flex;justify-content:space-between;">
            <span>${progressLabel}</span>
          </div>` : ""}
          <div style="margin-top:10px; border-top: 1px solid var(--border); padding-top: 8px;">
            <div class="status-label" style="margin-bottom:4px">Prompt</div>
            <div style="font-size:11px;color:var(--muted);max-height:48px;overflow-y:auto;word-break:break-all;font-family:var(--font-mono);line-height:1.4;">
              ${escHtml(q.prompt || "—")}
            </div>
          </div>
          <div style="display: flex; gap: 8px;">
            ${q.active ? `
              <button class="btn-stop btn-stop-queue" data-url="${escHtml(q.chatUrl)}" style="margin-top:12px; padding: 6px 12px; font-size:11px; flex: 1;">■ Stop Queue</button>
            ` : `
              <button class="btn-ghost btn-remove-queue" data-url="${escHtml(q.chatUrl)}" style="margin-top:12px; padding: 6px 12px; font-size:11px; flex: 1; text-align: center;">🗑 Remove History</button>
            `}
          </div>
        </div>
      `;
    });

    el.innerHTML = html;

    // Attach listeners
    el.querySelectorAll(".btn-stop-queue").forEach(btn => {
      btn.onclick = () => {
        const url = btn.dataset.url;
        chrome.runtime.sendMessage({ type: "STOP_RESUME", chatUrl: url }, () => {
          toast("✓ Queue stopped");
          updateUI();
          renderStatus();
        });
      };
    });

    el.querySelectorAll(".btn-remove-queue").forEach(btn => {
      btn.onclick = () => {
        const url = btn.dataset.url;
        chrome.storage.local.get("queues", d => {
          const queues = d.queues || {};
          delete queues[url];
          chrome.storage.local.set({ queues }, () => {
            toast("✓ Queue removed from history");
            updateUI();
            renderStatus();
          });
        });
      };
    });

    // Fetch live usage from the active tab if it matches
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      let tab = tabs && tabs[0];
      if (tab && tab.url && ALLOWED_DOMAINS.some(d => tab.url.includes(d))) {
        fetchUsage(tab.id);
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
  const currentUrl = $("chatUrl").value.trim();
  chrome.runtime.sendMessage({ type: "GET_STATUS" }, resp => {
    const queues = resp?.queues || {};
    const box = $("logBox");
    
    const activeUrls = Object.keys(queues);
    if (activeUrls.length === 0) {
      box.innerHTML = `<span class="log-line" style="color:var(--muted)">No log entries yet.</span>`;
      return;
    }

    // Use current typed URL or fallback to the first queue
    const targetUrl = queues[currentUrl] ? currentUrl : activeUrls[0];
    const state = queues[targetUrl];

    if (!state || !state.log || state.log.length === 0) {
      box.innerHTML = `<span class="log-line">No log entries yet for ${getDomainName(targetUrl) || "AI"}.</span>`;
      return;
    }

    const platform = getDomainName(targetUrl) || "AI";
    const headerHtml = `<div style="font-size: 10px; color: var(--muted); border-bottom: 1px solid var(--border); padding-bottom: 6px; margin-bottom: 8px; font-family: var(--font-heading); font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">Showing Logs for: ${platform}</div>`;

    const logLines = state.log.map(line => {
      let cls = "";
      if (line.includes("✓") || line.includes("sent") || line.includes("Success")) cls = "success";
      else if (line.includes("⚠") || line.includes("Wait") || line.includes("Waiting")) cls = "warn";
      else if (line.includes("Checking") || line.includes("Attempt") || line.includes("Check")) cls = "info";
      else if (line.includes("✗") || line.includes("Failed") || line.includes("Error")) cls = "error";
      return `<span class="log-line ${cls}">${escHtml(line)}</span>`;
    }).join("\n");

    box.innerHTML = headerHtml + logLines;
    box.scrollTop = box.scrollHeight;
  });
}

// ── Update overall UI state ───────────────────────────────────────────
function updateUI() {
  chrome.runtime.sendMessage({ type: "GET_STATUS" }, resp => {
    const queues = resp?.queues || {};
    const activeList = Object.values(queues).filter(q => q.active);
    const pill    = document.getElementById("headerPill");
    const pillTxt = $("headerPillText");
    const btnStart = $("btnStart");
    const btnStop  = $("btnStop");
    const currentUrl = $("chatUrl").value.trim();

    if (activeList.length === 0) {
      pill.className = "status-pill idle";
      pillTxt.textContent = "Idle";
    } else {
      const hasChecking = activeList.some(q => q.status === "checking" || q.status === "sending");
      const hasWaiting = activeList.some(q => q.status === "waiting");
      if (hasChecking) {
        pill.className = "status-pill checking";
      } else if (hasWaiting) {
        pill.className = "status-pill waiting";
      } else {
        pill.className = "status-pill active";
      }
      pillTxt.textContent = `${activeList.length} Active`;
    }

    const currentQueue = currentUrl ? queues[currentUrl] : null;
    if (currentQueue && currentQueue.active) {
      btnStart.style.display = "none";
      btnStop.style.display = "block";
    } else {
      btnStart.style.display = "block";
      btnStop.style.display = "none";
      btnStart.disabled = false;
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

// ── Render templates ──────────────────────────────────────────────────
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

// ── Render settings panel ─────────────────────────────────────────────
function renderSettings() {
  chrome.storage.local.get(["soundPref", "fabEnabled", "autoCaptureEnabled", "promptHistory"], d => {
    $("selSound").value = d.soundPref || "chime";
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
          document.querySelector('[data-tab="setup"]').click();
        }
      };
    });
  });
}

// ── Load saved settings on open ───────────────────────────────────────
chrome.storage.local.get(["savedSettings", "autoCaptureEnabled", "soundPref"], ({ savedSettings, autoCaptureEnabled, soundPref }) => {
  if (savedSettings) {
    if (savedSettings.chatUrl)      $("chatUrl").value      = savedSettings.chatUrl;
    if (savedSettings.prompt)       $("prompt").value       = savedSettings.prompt;
    if (savedSettings.resetMinutes) $("resetMinutes").value = savedSettings.resetMinutes;
    if (savedSettings.checkInterval) $("checkInterval").value = savedSettings.checkInterval;
    updatePromptStats();
    updatePlatformBadge();
  }
  
  $("selSound").value = soundPref || "chime";
  
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

// Settings Listeners
$("selSound").addEventListener("change", () => {
  const val = $("selSound").value;
  chrome.storage.local.set({ soundPref: val }, () => {
    chrome.runtime.sendMessage({ type: "SET_SOUND_PREF", data: { soundPref: val } }, () => {
      chrome.tabs.query({}, tabs => {
        tabs.forEach(tab => {
          if (tab.url && ALLOWED_DOMAINS.some(d => tab.url.includes(d))) {
            chrome.tabs.sendMessage(tab.id, { type: "SETTING_CHANGED", key: "soundPref", val }, () => chrome.runtime.lastError);
          }
        });
      });
      toast("✓ Alert sound set to " + val.toUpperCase());
    });
  });
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
    soundPref: "chime",
    fabEnabled: true,
    autoCaptureEnabled: true
  }, () => {
    chrome.runtime.sendMessage({ type: "SET_SOUND_PREF", data: { soundPref: "chime" } });
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
