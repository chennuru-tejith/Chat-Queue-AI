// ChatQueue AI — Background Service Worker v5

const ALARM = "ar-monitor";
const MAX_ATTEMPTS = 120;

// ── Messages ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case "START_RESUME":
      startResume(msg.data);
      sendResponse({ ok: true });
      return false; // synchronous
    case "STOP_RESUME":
      stopResume();
      sendResponse({ ok: true });
      return false; // synchronous
    case "LIMIT_DETECTED":
      onLimitDetected(msg.resetMinutes);
      sendResponse({ ok: true });
      return false; // synchronous
    case "GET_STATUS":
      chrome.storage.local.get("resumeState", d => {
        sendResponse({ state: d.resumeState || null });
      });
      return true; // asynchronous
    case "SET_SOUND_PREF":
      chrome.storage.local.set({ soundEnabled: msg.data.enabled }, () => {
        sendResponse({ ok: true });
      });
      return true; // asynchronous
    case "GET_SOUND_PREF":
      chrome.storage.local.get("soundEnabled", d => {
        sendResponse({ enabled: d.soundEnabled !== undefined ? d.soundEnabled : true });
      });
      return true; // asynchronous
    case "LOCAL_SEND_START":
      updateState(s => { s.status = "sending"; return s; }, "In-page instant-send triggered...");
      sendResponse({ ok: true });
      return false; // synchronous
    case "LOCAL_SEND_SUCCESS":
      updateState(s => { s.status = "done"; s.active = false; return s; },
        `✓ Prompt sent successfully via in-page instant checker! (${msg.method || "ok"})`);
      chrome.alarms.clear(ALARM);
      chrome.alarms.clear("ar-wait-end");
      if (fastBgTimeout) clearTimeout(fastBgTimeout);

      if (sender.tab && sender.tab.id) {
        chrome.tabs.update(sender.tab.id, { active: true }, () => {
          if (sender.tab.windowId) {
            chrome.windows.update(sender.tab.windowId, { focused: true });
          }
        });
      }

      chrome.notifications.create({
        type: "basic",
        iconUrl: "icons/icon48.png",
        title: "ChatQueue AI ✓",
        message: "Your prompt was sent! The AI is responding."
      });
      sendResponse({ ok: true });
      return false; // synchronous
    case "LOCAL_SEND_FAILED":
      updateState(s => { s.status = "checking"; return s; },
        `Instant-send failed: ${msg.reason || "unknown"}. Re-entering checks...`);
      sendResponse({ ok: true });
      return false; // synchronous
    default:
      return false; // Unhandled type: do not return true to prevent port leaks
  }
});

// ── Start ─────────────────────────────────────────────────────────────
function startResume(data) {
  const allowed = ["claude.ai", "chatgpt.com", "gemini.google.com", "deepseek.com"];
  const isValid = allowed.some(domain => {
    try {
      const parsed = new URL(data?.chatUrl);
      return parsed.hostname.includes(domain) && data.chatUrl.startsWith("https://");
    } catch {
      return false;
    }
  });
  if (!isValid) return;

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
    log: [`[${ts()}] ChatQueue AI started. Monitoring for usage limit...`]
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
  if (fastBgTimeout) clearTimeout(fastBgTimeout);
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
        "Wait complete. Waking up tab and starting checks...");
      
      // Wake up tab by focusing it
      findOrOpenTab(s.chatUrl, (tabId) => {
        if (tabId) {
          chrome.tabs.update(tabId, { active: true });
        }
      });

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
          `Wait complete. Waking up tab and starting checks...`);
        
        // Wake up tab by focusing it
        findOrOpenTab(s.chatUrl, (tabId) => {
          if (tabId) {
            chrome.tabs.update(tabId, { active: true });
          }
        });
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

    findOrOpenTab(s.chatUrl, (tabId, wasCreated) => {
      if (!tabId) { addLog("Could not find/open AI tab"); return; }

      ensureTabReady(tabId, ready => {
        if (!ready) { addLog("AI tab load timed out"); return; }

        // Give page 2 seconds to run content scripts if newly created
        setTimeout(() => {
          chrome.tabs.sendMessage(tabId, { type: "CHECK_LIMIT" }, resp => {
            if (chrome.runtime.lastError || !resp) return;

            if (resp.limited) {
              chrome.tabs.sendMessage(tabId, { type: "GET_RESET_INFO" }, ri => {
                const mins = (ri && ri.mins) ? ri.mins : 0;
                onLimitDetected(mins);
              });
            } else if (resp.canType) {
              attemptSend(s);
            }
          });
        }, wasCreated ? 2500 : 500);
      });
    });
  });
}

// ── Limit detected ────────────────────────────────────────────────────
function onLimitDetected(detectedMins) {
  chrome.storage.local.get("resumeState", d => {
    const s = d.resumeState;
    if (!s?.active || s.limitDetectedAt) return; // already handling

    const minsToWait = detectedMins || s.resetMinutes || 180;

    updateState(st => {
      st.limitDetectedAt = Date.now();
      st.status = "waiting";
      st.resetMinutes = minsToWait;
      return st;
    }, `Usage limit detected! Waiting ${minsToWait} min before checking...`);

    // Use alarm for the wait (survives SW sleep)
    chrome.alarms.clear(ALARM, () => {
      // During wait: alarm every 2 min to update progress
      chrome.alarms.create(ALARM, { periodInMinutes: 2 });
      // After wait: create a one-shot alarm to switch to checking
      chrome.alarms.create("ar-wait-end", { delayInMinutes: minsToWait });
    });
  });
}

// ── Attempt to send ───────────────────────────────────────────────────
function attemptSend(state) {
  const attempt = (state.attempts || 0) + 1;

  if (attempt >= MAX_ATTEMPTS) {
    addLog(`✗ Gave up after ${MAX_ATTEMPTS} attempts.`);
    updateState(s => { s.active = false; s.status = "failed"; return s; });
    chrome.alarms.clear(ALARM);
    chrome.alarms.clear("ar-wait-end");
    return;
  }

  updateState(s => { s.attempts = attempt; return s; });
  addLog(`Check #${attempt} — testing if limit has reset...`);

  findOrOpenTab(state.chatUrl, (tabId, wasCreated) => {
    if (!tabId) {
      addLog("Could not reach AI tab. Will retry next cycle.");
      return;
    }

    const reloadAndProceed = () => {
      chrome.tabs.reload(tabId, { bypassCache: true }, () => {
        ensureTabReady(tabId, ready => {
          if (!ready) {
            addLog("Tab reload timed out. Will retry next cycle.");
            return;
          }
          // Wait 3.5s for page scripts initialization and DOM hydration
          setTimeout(() => runCheck(true), 3500);
        });
      });
    };

    const runCheck = (isFresh) => {
      chrome.tabs.get(tabId, tab => {
        if (chrome.runtime.lastError || !tab) {
          addLog("Tab was closed. Will retry next cycle.");
          return;
        }
        chrome.tabs.sendMessage(tabId, { type: "CHECK_LIMIT" }, resp => {
          if (chrome.runtime.lastError || !resp) {
            if (!isFresh) {
              addLog("Tab unresponsive. Reloading connection...");
              reloadAndProceed();
            } else {
              addLog("Content script not responding. Retrying...");
            }
            return;
          }

          if (resp.limited) {
            addLog(`Still limited. Retrying...`);
            scheduleFastBackgroundCheck(10000);
            return;
          }

          if (resp.canType) {
            // Focus tab and window to wake it up
            chrome.tabs.update(tabId, { active: true }, () => {
              chrome.tabs.get(tabId, tab => {
                if (!chrome.runtime.lastError && tab && tab.windowId) {
                  chrome.windows.update(tab.windowId, { focused: true });
                }
              });
            });

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

                chrome.notifications.create({
                  type: "basic",
                  iconUrl: "icons/icon48.png",
                  title: "ChatQueue AI ✓",
                  message: "Your prompt was sent! The AI is responding."
                });

                chrome.storage.local.get("soundEnabled", d => {
                  if (d.soundEnabled !== false) {
                    chrome.tabs.sendMessage(tabId, { type: "PLAY_NOTIFICATION_SOUND" },
                      () => chrome.runtime.lastError);
                  }
                });

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
      });
    };

    if (wasCreated) {
      ensureTabReady(tabId, ready => {
        if (!ready) {
          addLog("Created tab load timed out. Retrying next cycle.");
          return;
        }
        setTimeout(() => runCheck(true), 3500);
      });
    } else {
      // Ping the tab first. If it responds, check immediately without reloading!
      chrome.tabs.sendMessage(tabId, { type: "CHECK_LIMIT" }, resp => {
        if (chrome.runtime.lastError || !resp) {
          addLog("Tab not responding. Reloading tab...");
          reloadAndProceed();
        } else {
          runCheck(false);
        }
      });
    }
  });
}

// ── Find or open AI tab ───────────────────────────────────────────────
function cleanUrlForComparison(urlStr) {
  try {
    const u = new URL(urlStr);
    let path = u.pathname.replace(/\/$/, "").toLowerCase();
    return u.hostname.toLowerCase() + path;
  } catch {
    return urlStr ? urlStr.toLowerCase() : "";
  }
}

function findOrOpenTab(chatUrl, callback) {
  try {
    const domain = new URL(chatUrl).hostname;
    const baseDomain = domain.split('.').slice(-2).join('.');
    const queryUrl = `*://*.${baseDomain}/*`;

    chrome.tabs.query({ url: queryUrl }, tabs => {
      const cleanTarget = cleanUrlForComparison(chatUrl);
      const exact = tabs.find(t => {
        if (!t.url) return false;
        const cleanTab = cleanUrlForComparison(t.url);
        return cleanTab === cleanTarget || cleanTab.startsWith(cleanTarget + "/");
      });
      if (exact) { callback(exact.id, false); return; }
      if (tabs[0]) { callback(tabs[0].id, false); return; }
      chrome.tabs.create({ url: chatUrl, active: false }, t => callback(t.id, true));
    });
  } catch (err) {
    chrome.tabs.create({ url: chatUrl, active: false }, t => callback(t.id, true));
  }
}

// ── Ensure tab is fully loaded ────────────────────────────────────────
function ensureTabReady(tabId, callback) {
  chrome.tabs.get(tabId, tab => {
    if (chrome.runtime.lastError || !tab) {
      callback(false);
      return;
    }
    if (tab.status === "complete") {
      callback(true);
    } else {
      let resolved = false;
      const listener = (tid, changeInfo) => {
        if (tid === tabId && changeInfo.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          if (!resolved) {
            resolved = true;
            callback(true);
          }
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      // Timeout after 15 seconds to prevent memory leaks
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        if (!resolved) {
          resolved = true;
          callback(false);
        }
      }, 15000);
    }
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
  const allowedDomains = ["claude.ai", "chatgpt.com", "gemini.google.com", "deepseek.com"];
  chrome.tabs.query({}, tabs => {
    for (const tab of tabs) {
      if (tab.url) {
        try {
          const parsed = new URL(tab.url);
          if (allowedDomains.some(d => parsed.hostname.includes(d))) {
            chrome.tabs.sendMessage(tab.id, { type: "STATE_UPDATED", state },
              () => chrome.runtime.lastError);
          }
        } catch {}
      }
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
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const tab = tabs[0];
    if (!tab || !tab.url) return;
    const allowedDomains = ["claude.ai", "chatgpt.com", "gemini.google.com", "deepseek.com"];
    try {
      const parsed = new URL(tab.url);
      if (!allowedDomains.some(d => parsed.hostname.includes(d))) return;

      if (command === "toggle-panel") {
        chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_PANEL" },
          () => chrome.runtime.lastError);
      }
      if (command === "toggle-chatqueue") {
        chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_CHATQUEUE" },
          () => chrome.runtime.lastError);
      }
    } catch {}
  });
});

// ── Fast background check loop helper ──────────────────────────────────
let fastBgTimeout = null;
function scheduleFastBackgroundCheck(ms) {
  if (fastBgTimeout) clearTimeout(fastBgTimeout);
  fastBgTimeout = setTimeout(() => {
    chrome.storage.local.get("resumeState", d => {
      const s = d.resumeState;
      if (s && s.active && s.status === "checking") {
        attemptSend(s);
      }
    });
  }, ms);
}
