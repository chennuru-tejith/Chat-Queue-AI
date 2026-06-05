// Claude AutoResume — Popup Script

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
  });
});

// ── Use current tab button ────────────────────────────────────────────
$("btnCurrentTab").addEventListener("click", () => {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    if (tabs[0] && tabs[0].url.includes("claude.ai")) {
      $("chatUrl").value = tabs[0].url;
      toast("✓ URL captured");
    } else {
      toast("Open a Claude chat first");
    }
  });
});

// ── Start ─────────────────────────────────────────────────────────────
$("btnStart").addEventListener("click", () => {
  const chatUrl      = $("chatUrl").value.trim();
  const prompt       = $("prompt").value.trim();
  const resetMinutes = parseInt($("resetMinutes").value) || 180;
  const checkInterval = parseInt($("checkInterval").value) || 60;

  if (!chatUrl.startsWith("https://claude.ai/chat/")) {
    toast("⚠ Enter a valid Claude chat URL"); return;
  }
  if (!prompt) {
    toast("⚠ Enter a resume prompt"); return;
  }

  // Save settings for persistence
  chrome.storage.local.set({ savedSettings: { chatUrl, prompt, resetMinutes, checkInterval } });

  chrome.runtime.sendMessage({
    type: "START_RESUME",
    data: { chatUrl, prompt, resetMinutes, checkInterval }
  }, () => {
    toast("✓ AutoResume started!");
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
      progress = Math.min(95, (elapsed / state.resetMinutes) * 100);
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
        <div class="status-label" style="margin-bottom:8px">Resume Prompt</div>
        <div style="font-size:12px;color:var(--text);line-height:1.6;word-break:break-word;">
          ${escHtml(state.prompt || "—")}
        </div>
      </div>

      ${state.active ? `<button class="btn-stop" id="btnStop2">■ Stop AutoResume</button>` : ""}
    `;

    // Re-attach stop button
    const stop2 = $("btnStop2");
    if (stop2) stop2.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "STOP_RESUME" }, () => {
        toast("Stopped"); updateUI(); renderStatus();
      });
    });
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
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2200);
}

function escHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Load saved settings on open ───────────────────────────────────────
chrome.storage.local.get("savedSettings", ({ savedSettings }) => {
  if (savedSettings) {
    if (savedSettings.chatUrl)      $("chatUrl").value      = savedSettings.chatUrl;
    if (savedSettings.prompt)       $("prompt").value       = savedSettings.prompt;
    if (savedSettings.resetMinutes) $("resetMinutes").value = savedSettings.resetMinutes;
    if (savedSettings.checkInterval) $("checkInterval").value = savedSettings.checkInterval;
  }
});

// ── Auto-detect timer from active Claude tab ─────────────────────────
function autoDetectTimer() {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const tab = tabs[0];
    if (!tab || !tab.url?.includes("claude.ai")) return;
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

// Auto-refresh status every 5 seconds when popup is open
setInterval(() => {
  const activeTab = document.querySelector(".tab.active");
  if (activeTab?.dataset.tab === "status") renderStatus();
  if (activeTab?.dataset.tab === "log") renderLog();
  updateUI();
}, 5000);
