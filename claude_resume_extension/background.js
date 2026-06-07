// Claude AutoResume — Background Service Worker v5

const ALARM = "ar-monitor";
const MAX_ATTEMPTS = 120;

// ── Messages ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "START_RESUME")   { startResume(msg.data);     sendResponse({ ok: true }); }
  if (msg.type === "STOP_RESUME")    { stopResume();               sendResponse({ ok: true }); }
  if (msg.type === "LIMIT_DETECTED") { onLimitDetected();          sendResponse({ ok: true }); }
  if (msg.type === "GET_STATUS")     {
    chrome.storage.local.get("resumeState", d => sendResponse({ state: d.resumeState || null }));
    return true;
  }

  // ── Usage history ────────────────────────────────────────────────
  if (msg.type === "RECORD_USAGE") {
    const point = { t: Date.now(), s: msg.data.session, w: msg.data.weekly };
    chrome.storage.local.get("usageHistory", d => {
      const history = d.usageHistory || [];
      history.push(point);
      if (history.length > 50) history.splice(0, history.length - 50);
      chrome.storage.local.set({ usageHistory: history }, () => sendResponse({ ok: true }));
    });
    return true;
  }
  if (msg.type === "GET_USAGE_HISTORY") {
    chrome.storage.local.get("usageHistory", d => sendResponse({ history: d.usageHistory || [] }));
    return true;
  }

  // ── Sound preference ─────────────────────────────────────────────
  if (msg.type === "SET_SOUND_PREF") {
    chrome.storage.local.set({ soundEnabled: msg.data.enabled }, () => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "GET_SOUND_PREF") {
    chrome.storage.local.get("soundEnabled", d => {
      sendResponse({ enabled: d.soundEnabled !== undefined ? d.soundEnabled : true });
    });
    return true;
  }

  return true;
});

// ── Start ─────────────────────────────────────────────────────────────
function startResume(data) {
  if (!data?.chatUrl?.startsWith("https://claude.ai/chat/")) return;

  const state = {
    active: true,
    chatUrl: data.chatUrl,
    prompt: data.prompt,
    resetMinutes: data.resetMinutes ?? 0,
    checkInterval: data.checkInterval || 60,
    status: "monitoring",
    startedAt: Date.now(),
    limitDetectedAt: null,
    attempts: 0,
    log: [`[${ts()}] AutoResume started. Monitoring for usage limit...`]
  };

  chrome.storage.local.set({ resumeState: state }, () => {
    chrome.alarms.clear(ALARM, () => {
      // Alarm fires every minute for monitoring
      chrome.alarms.create(ALARM, { periodInMinutes: 1 });
    });
    broadcast(state);
    updateBadge(state);

    // Check immediately — don't wait 60s
    setTimeout(() => checkImmediately(), 2000);
  });
}

// ── Stop ──────────────────────────────────────────────────────────────
function stopResume() {
  chrome.alarms.clear(ALARM);
  chrome.alarms.clear("ar-wait-end");
  updateState(s => {
    s.active = false;
    s.status = "stopped";
    return s;
  }, "Stopped by user.");
}

// ── Alarm tick ────────────────────────────────────────────────────────
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === "ar-wait-end") {
    // Wait-end alarm: switch from waiting to checking
    chrome.storage.local.get("resumeState", d => {
      const s = d.resumeState;
      if (!s?.active || s.status !== "waiting") return;
      updateState(st => { st.status = "checking"; return st; },
        "Wait complete. Now checking every minute...");
      // Switch alarm back to 1 min for checking
      chrome.alarms.clear(ALARM, () => {
        chrome.alarms.create(ALARM, { periodInMinutes: 1 });
      });
    });
    return;
  }

  if (alarm.name !== ALARM) return;
  chrome.storage.local.get("resumeState", d => {
    const s = d.resumeState;
    if (!s?.active) { chrome.alarms.clear(ALARM); return; }

    if (s.status === "monitoring") {
      // Ask the Claude tab if limit is active
      checkImmediately();
    } else if (s.status === "waiting") {
      const elapsed = (Date.now() - s.limitDetectedAt) / 60000;
      const rem = s.resetMinutes - elapsed;
      if (rem <= 0) {
        // Time is up — start checking
        updateState(st => { st.status = "checking"; return st; },
          `Wait complete. Starting checks...`);
      } else {
        addLog(`Waiting... ${Math.ceil(rem)} min remaining`);
      }
    } else if (s.status === "checking") {
      attemptSend(s);
    }
  });
});

// ── Immediately check limit state ────────────────────────────────────
function checkImmediately() {
  chrome.storage.local.get("resumeState", d => {
    const s = d.resumeState;
    if (!s?.active) return;

    findOrOpenTab(s.chatUrl, tabId => {
      if (!tabId) { addLog("Could not find/open Claude tab"); return; }

      chrome.tabs.sendMessage(tabId, { type: "CHECK_LIMIT" }, resp => {
        if (chrome.runtime.lastError || !resp) return;

        if (resp.limited) {
          onLimitDetected();
        } else if (resp.canType && s.status === "checking") {
          // Limit has cleared! Send now
          attemptSend(s);
        } else if (resp.canType && s.status === "monitoring") {
          addLog("Monitoring — limit not yet active, watching...");
        }
      });
    });
  });
}

// ── Limit detected ────────────────────────────────────────────────────
function onLimitDetected() {
  chrome.storage.local.get("resumeState", d => {
    const s = d.resumeState;
    if (!s?.active || s.limitDetectedAt) return; // already handling

    updateState(st => {
      st.limitDetectedAt = Date.now();
      st.status = "waiting";
      return st;
    }, `Usage limit detected! Waiting ${s.resetMinutes} min before checking...`);

    // Use alarm for the wait (survives SW sleep)
    chrome.alarms.clear(ALARM, () => {
      // During wait: alarm every 2 min to update progress
      chrome.alarms.create(ALARM, { periodInMinutes: 2 });
      // After wait: create a one-shot alarm to switch to checking
      chrome.alarms.create("ar-wait-end", { delayInMinutes: s.resetMinutes || 1 });
    });
  });
}


// ── Attempt to send ───────────────────────────────────────────────────
function attemptSend(state) {
  const attempt = (state.attempts || 0) + 1;

  // Check MAX_ATTEMPTS FIRST to avoid race with async send below
  if (attempt >= MAX_ATTEMPTS) {
    addLog(`✗ Gave up after ${MAX_ATTEMPTS} attempts.`);
    updateState(s => { s.active = false; s.status = "failed"; return s; });
    chrome.alarms.clear(ALARM);
    chrome.alarms.clear("ar-wait-end");
    return;
  }

  updateState(s => { s.attempts = attempt; return s; });
  addLog(`Check #${attempt} — testing if limit has reset...`);

  findOrOpenTab(state.chatUrl, tabId => {
    if (!tabId) {
      addLog("Could not reach Claude tab. Will retry next cycle.");
      return;
    }

    // First reload the page to get a fresh limit state
    chrome.tabs.reload(tabId, { bypassCache: true }, () => {
      setTimeout(() => {
        chrome.tabs.sendMessage(tabId, { type: "CHECK_LIMIT" }, resp => {
          if (chrome.runtime.lastError || !resp) {
            addLog("Content script not responding. Retrying...");
            return;
          }

          if (resp.limited) {
            addLog(`Still limited. Next check in 1 min...`);
            return; // alarm will retry
          }

          if (resp.canType) {
            // Limit has reset! Send the prompt
            addLog("Limit has RESET! Sending prompt now...");
            updateState(s => { s.status = "sending"; return s; });

            chrome.tabs.sendMessage(tabId, {
              type: "CHECK_AND_SEND",
              prompt: state.prompt
            }, result => {
              if (chrome.runtime.lastError || !result) {
                addLog("Send failed — will retry next cycle.");
                updateState(s => { s.status = "checking"; return s; });
                return;
              }

              if (result.sent) {
                addLog(`✓ Prompt sent successfully! (${result.method || "ok"})`);
                updateState(s => { s.status = "done"; s.active = false; return s; });
                chrome.alarms.clear(ALARM);
                chrome.alarms.clear("ar-wait-end");

                // Notification
                chrome.notifications.create({
                  type: "basic",
                  iconUrl: "icons/icon48.png",
                  title: "Claude AutoResume ✓",
                  message: "Your prompt was sent! Claude is responding."
                });

                // Sound notification
                chrome.storage.local.get("soundEnabled", d => {
                  if (d.soundEnabled !== false) {
                    chrome.tabs.sendMessage(tabId, { type: "PLAY_NOTIFICATION_SOUND" },
                      () => chrome.runtime.lastError);
                  }
                });

                // Focus tab
                chrome.tabs.update(tabId, { active: true });

              } else if (result.reason === "still_limited") {
                addLog("Page says still limited. Retrying...");
                updateState(s => { s.status = "checking"; return s; });
              } else {
                addLog(`Send failed: ${result.reason}. Retrying...`);
                updateState(s => { s.status = "checking"; return s; });
              }
            });
          } else {
            addLog("Cannot type yet. Still waiting...");
          }
        });
      }, 5000); // wait 5s after reload for page to settle
    });
  });
}

// ── Find or open Claude tab ───────────────────────────────────────────
function findOrOpenTab(chatUrl, callback) {
  chrome.tabs.query({ url: "https://claude.ai/*" }, tabs => {
    // Prefer exact chat URL
    const exact = tabs.find(t => t.url === chatUrl ||
      t.url.includes(chatUrl.split("/").pop()));
    if (exact) { callback(exact.id); return; }
    // Any claude tab
    if (tabs[0]) { callback(tabs[0].id); return; }
    // Open new tab
    chrome.tabs.create({ url: chatUrl, active: false }, t => callback(t.id));
  });
}

// ── State helpers ─────────────────────────────────────────────────────
function updateState(mutator, logMsg) {
  chrome.storage.local.get("resumeState", d => {
    const s = d.resumeState;
    if (!s) return;
    const updated = mutator(s);
    if (!updated) return;
    if (logMsg) {
      updated.log = updated.log || [];
      updated.log.push(`[${ts()}] ${logMsg}`);
      if (updated.log.length > 80) updated.log = updated.log.slice(-80);
    }
    chrome.storage.local.set({ resumeState: updated }, () => {
      broadcast(updated);
      updateBadge(updated);
    });
  });
}

function addLog(msg) {
  updateState(s => {
    s.log = s.log || [];
    s.log.push(`[${ts()}] ${msg}`);
    if (s.log.length > 80) s.log = s.log.slice(-80);
    return s;
  });
}

function broadcast(state) {
  if (!state) return;
  chrome.tabs.query({ url: "https://claude.ai/*" }, tabs => {
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { type: "STATE_UPDATED", state },
        () => chrome.runtime.lastError);
    }
  });
}

function ts() {
  return new Date().toLocaleTimeString("en-IN", { hour12: false });
}

function updateBadge(state) {
  if (!state || !state.active) {
    chrome.action.setBadgeText({ text: "" });
    return;
  }

  let text = "";
  let color = "#6e6e80"; // muted gray

  switch (state.status) {
    case "monitoring":
      text = "MON";
      color = "#4ade80"; // green
      break;
    case "waiting":
      if (state.limitDetectedAt && state.resetMinutes) {
        const elapsed = (Date.now() - state.limitDetectedAt) / 60000;
        const remaining = Math.max(0, state.resetMinutes - elapsed);
        if (remaining > 60) {
          text = Math.ceil(remaining / 60) + "h";
        } else {
          text = Math.ceil(remaining) + "m";
        }
      } else {
        text = "WAIT";
      }
      color = "#facc15"; // yellow
      break;
    case "checking":
      text = "CHK";
      color = "#60a5fa"; // blue
      break;
    case "sending":
      text = "SEND";
      color = "#60a5fa"; // blue
      break;
    case "done":
      text = "DONE";
      color = "#4ade80"; // green
      break;
    case "failed":
      text = "ERR";
      color = "#f87171"; // red
      break;
    default:
      text = "ON";
      color = "#a78bfa"; // purple
  }

  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ resumeState: null });
  updateBadge(null);
});

// ── Keyboard shortcuts ─────────────────────────────────────────────────
chrome.commands.onCommand.addListener(command => {
  chrome.tabs.query({ url: "https://claude.ai/*", active: true, currentWindow: true }, tabs => {
    const tab = tabs[0];
    if (!tab) return;

    if (command === "toggle-panel") {
      chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_PANEL" },
        () => chrome.runtime.lastError);
    }
    if (command === "toggle-autoresume") {
      chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_AUTORESUME" },
        () => chrome.runtime.lastError);
    }
  });
});
