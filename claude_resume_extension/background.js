// Claude AutoResume — Background Service Worker v4

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
  return true;
});

// ── Start ─────────────────────────────────────────────────────────────
function startResume(data) {
  if (!data?.chatUrl?.startsWith("https://claude.ai/chat/")) return;

  const state = {
    active: true,
    chatUrl: data.chatUrl,
    prompt: data.prompt,
    resetMinutes: data.resetMinutes || 180,
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

    // Check immediately — don't wait 60s
    setTimeout(() => checkImmediately(), 2000);
  });
}

// ── Stop ──────────────────────────────────────────────────────────────
function stopResume() {
  chrome.alarms.clear(ALARM);
  updateState(s => {
    s.active = false;
    s.status = "stopped";
    return s;
  }, "Stopped by user.");
}

// ── Alarm tick ────────────────────────────────────────────────────────
chrome.alarms.onAlarm.addListener(alarm => {
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

    // After resetMinutes, switch to checking
    const delay = (s.resetMinutes || 180) * 60 * 1000;
    // Use alarm for the wait (survives SW sleep)
    chrome.alarms.clear(ALARM, () => {
      // During wait: alarm every 2 min to update progress
      chrome.alarms.create(ALARM, { periodInMinutes: 2 });
      // After wait: create a one-shot alarm to switch to checking
      chrome.alarms.create("ar-wait-end", { delayInMinutes: s.resetMinutes || 180 });
    });
  });
}

// ── Wait end alarm ────────────────────────────────────────────────────
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== "ar-wait-end") return;
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
});

// ── Attempt to send ───────────────────────────────────────────────────
function attemptSend(state) {
  const attempt = (state.attempts || 0) + 1;
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

  // Give up after MAX_ATTEMPTS
  if (attempt >= MAX_ATTEMPTS) {
    addLog(`✗ Gave up after ${MAX_ATTEMPTS} attempts.`);
    updateState(s => { s.active = false; s.status = "failed"; return s; });
    chrome.alarms.clear(ALARM);
    chrome.alarms.clear("ar-wait-end");
  }
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

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ resumeState: null });
});
