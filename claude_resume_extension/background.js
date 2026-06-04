// Claude AutoResume — Background Service Worker (fixed)

const ALARM_MONITOR  = "ar-monitor";   // fires every minute while monitoring
const ALARM_WAIT_END = "ar-wait-end";  // fires once when wait period expires
const MAX_ATTEMPTS   = 60;             // give up after 60 retries (~60 min)

// ── Message router ────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "START_RESUME") {
    startResume(msg.data);
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === "STOP_RESUME") {
    stopResume();
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === "GET_STATUS") {
    chrome.storage.local.get("resumeState", (d) => {
      sendResponse({ state: d.resumeState || null });
    });
    return true; // async
  }
  if (msg.type === "LIMIT_DETECTED") {
    onLimitDetected();
    return;
  }
  if (msg.type === "SEND_RESULT") {
    addLog(msg.success ? `✓ ${msg.detail}` : `✗ ${msg.detail}`);
    sendResponse({ ok: true });
    return;
  }
  // OPEN_POPUP: open the extension popup programmatically
  if (msg.type === "OPEN_POPUP") {
    // openPopup() requires user gesture — silently fails from content script
    // Best we can do: focus the extension icon badge (no reliable cross-platform way)
    // Just update the badge to draw attention
    chrome.action.setBadgeText({ text: "!" });
    chrome.action.setBadgeBackgroundColor({ color: "#a78bfa" });
    setTimeout(() => chrome.action.setBadgeText({ text: "" }), 4000);
    return;
  }
  return true;
});

// ── Start ─────────────────────────────────────────────────────────────
function startResume(data) {
  // Validate URL format
  if (!data.chatUrl || !data.chatUrl.startsWith("https://claude.ai/chat/")) {
    console.error("AutoResume: invalid chatUrl", data.chatUrl);
    return;
  }
  const state = {
    active:           true,
    chatUrl:          data.chatUrl,
    prompt:           data.prompt,
    resetMinutes:     data.resetMinutes  || 180,
    checkIntervalSec: data.checkInterval || 60,
    status:           "monitoring",
    startedAt:        Date.now(),
    limitDetectedAt:  null,
    attempts:         0,
    log: [`[${ts()}] AutoResume started. Monitoring for usage limit...`]
  };

  chrome.storage.local.set({ resumeState: state }, () => {
    chrome.alarms.clearAll(() => {
      chrome.alarms.create(ALARM_MONITOR, { periodInMinutes: 1 });
    });
    addLog("Monitoring active. Waiting for limit banner...");
    // Check immediately — don't wait up to 60s for first alarm tick
    ensureClaudeTab(state.chatUrl, (tabId) => {
      if (tabId === null) return;
      setTimeout(() => {
        chrome.tabs.sendMessage(tabId, { type: "CHECK_LIMIT" }, (resp) => {
          if (chrome.runtime.lastError) return;
          if (resp?.limited) onLimitDetected();
        });
      }, 2000); // wait 2s for page to settle
    });
  });
}

// ── Stop ──────────────────────────────────────────────────────────────
function stopResume() {
  chrome.alarms.clearAll();
  updateState(s => {
    s.active = false;
    s.status = "stopped";
    return s;
  }, "Stopped by user.");
}

// ── Limit detected by content script ─────────────────────────────────
function onLimitDetected() {
  chrome.storage.local.get("resumeState", (d) => {
    const s = d.resumeState;
    if (!s || !s.active || s.limitDetectedAt) return; // already handling

    s.limitDetectedAt = Date.now();
    s.status = "waiting";
    s.log = s.log || [];
    s.log.push(`[${ts()}] Usage limit detected! Waiting ${s.resetMinutes} min...`);
    chrome.storage.local.set({ resumeState: s });

    // FIX 2: Schedule wait-end with chrome.alarms (survives SW restarts)
    chrome.alarms.create(ALARM_WAIT_END, {
      delayInMinutes: s.resetMinutes
    });
  });
}

// ── Alarms ────────────────────────────────────────────────────────────
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_WAIT_END) {
    // Wait period is over — start checking
    updateState(s => {
      if (s && s.active && s.status === "waiting") {
        s.status = "checking";
        return s;
      }
      return null;
    }, "Wait complete. Now checking if limit has reset...");
    return;
  }

  if (alarm.name === ALARM_MONITOR) {
    chrome.storage.local.get("resumeState", (d) => {
      const s = d.resumeState;
      if (!s || !s.active) { chrome.alarms.clearAll(); return; }

      if (s.status === "monitoring") {
        // Ensure Claude tab is open and check for limit
        ensureClaudeTab(s.chatUrl, (tabId) => {
          if (tabId === null) return;
          chrome.tabs.sendMessage(tabId, { type: "CHECK_LIMIT" }, (resp) => {
            if (chrome.runtime.lastError) return;
            if (resp?.limited) onLimitDetected();
          });
        });
        return;
      }

      if (s.status === "checking") {
        // FIX 5: Respect user's checkIntervalSec setting
        // We fire every minute but only actually attempt after checkIntervalSec
        const secSinceDetected = (Date.now() - (s.lastAttemptAt || s.limitDetectedAt || 0)) / 1000;
        if (s.attempts > 0 && secSinceDetected < (s.checkIntervalSec - 5)) {
          return; // not time yet
        }

        // FIX 11: Cap maximum attempts
        if (s.attempts >= MAX_ATTEMPTS) {
          updateState(st => { st.status = "failed"; st.active = false; return st; },
            `Gave up after ${MAX_ATTEMPTS} attempts. Please check Claude manually.`);
          chrome.alarms.clearAll();
          return;
        }

        attemptSend(s);
      }

      if (s.status === "waiting") {
        // FIX 8: If we somehow ended up here (SW restarted, alarm-wait-end missed)
        // check if the wait time has actually passed
        if (s.limitDetectedAt) {
          const elapsed = (Date.now() - s.limitDetectedAt) / 60000;
          if (elapsed >= s.resetMinutes) {
            updateState(st => { st.status = "checking"; return st; },
              "Wait time elapsed (recovered from SW restart). Checking now...");
          } else {
            const rem = Math.ceil(s.resetMinutes - elapsed);
            addLog(`Waiting for reset... ${rem} min remaining.`);
          }
        }
      }
    });
  }
});

// ── Attempt to send ───────────────────────────────────────────────────
function attemptSend(state) {
  // FIX 2: Save state BEFORE incrementing, then write back atomically
  chrome.storage.local.get("resumeState", (d) => {
    const s = d.resumeState;
    if (!s || !s.active) return;

    s.attempts     = (s.attempts || 0) + 1;
    s.lastAttemptAt = Date.now();
    s.log = s.log || [];
    s.log.push(`[${ts()}] Attempt #${s.attempts} — checking Claude...`);
    if (s.log.length > 50) s.log = s.log.slice(-50);

    chrome.storage.local.set({ resumeState: s }, () => {
      // FIX 7: Only use the exact target tab, never a fallback
      findExactTab(s.chatUrl, (tabId) => {
        if (tabId === null) {
          // Open tab if not present
          chrome.tabs.create({ url: s.chatUrl, active: false }, (tab) => {
            setTimeout(() => tryInjectAndSend(tab.id, s.prompt), 8000);
          });
        } else {
          chrome.tabs.update(tabId, { url: s.chatUrl }, () => {
            setTimeout(() => tryInjectAndSend(tabId, s.prompt), 8000);
          });
        }
      });
    });
  });
}

function tryInjectAndSend(tabId, prompt) {
  chrome.tabs.sendMessage(tabId, { type: "CHECK_AND_SEND", prompt }, (resp) => {
    if (chrome.runtime.lastError) {
      addLog("Content script unreachable. Retrying next cycle...");
      return;
    }
    if (resp?.sent) {
      chrome.storage.local.get("resumeState", (d) => {
        const s = d.resumeState || {};
        s.status = "done";
        s.active = false;
        s.log = s.log || [];
        s.log.push(`[${ts()}] ✓ Prompt sent successfully!`);
        chrome.storage.local.set({ resumeState: s });
        chrome.alarms.clearAll();
        chrome.notifications.create({
          type: "basic",
          iconUrl: "icons/icon48.png",
          title: "Claude AutoResume",
          message: "Your prompt was sent! Claude is responding."
        });
        chrome.tabs.update(tabId, { active: true });
      });
    } else if (resp?.stillLimited) {
      addLog("Still rate limited. Retrying...");
    } else {
      addLog(`Send failed: ${resp?.reason || "unknown"}. Retrying...`);
    }
  });
}

// ── Tab helpers ───────────────────────────────────────────────────────

// FIX 7: Only match the exact target chat URL — never fallback to random tab
function findExactTab(chatUrl, callback) {
  const convId = chatUrl.split("/").pop();
  chrome.tabs.query({ url: "https://claude.ai/*" }, (tabs) => {
    const match = tabs.find(t =>
      t.url === chatUrl || (convId && t.url.includes(convId))
    );
    callback(match ? match.id : null);
  });
}

// For monitoring: open chat if not open, but don't navigate existing tabs
function ensureClaudeTab(chatUrl, callback) {
  findExactTab(chatUrl, (tabId) => {
    if (tabId !== null) { callback(tabId); return; }
    chrome.tabs.create({ url: chatUrl, active: false }, (tab) => {
      setTimeout(() => callback(tab.id), 3000);
    });
  });
}

// ── State helper — atomic read-modify-write ───────────────────────────
function updateState(mutator, logMsg) {
  chrome.storage.local.get("resumeState", (d) => {
    const s = d.resumeState;
    if (!s) return;
    const updated = mutator(s);
    if (!updated) return;
    if (logMsg) {
      updated.log = updated.log || [];
      updated.log.push(`[${ts()}] ${logMsg}`);
      if (updated.log.length > 50) updated.log = updated.log.slice(-50);
    }
    chrome.storage.local.set({ resumeState: updated });
  });
}

function addLog(msg) {
  updateState(s => {
    s.log = s.log || [];
    s.log.push(`[${ts()}] ${msg}`);
    if (s.log.length > 50) s.log = s.log.slice(-50);
    return s;
  });
}

function ts() {
  return new Date().toLocaleTimeString("en-IN", { hour12: false });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ resumeState: null });
});
