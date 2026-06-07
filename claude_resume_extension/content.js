// Claude AutoResume — Content Script v4
// Complete rewrite: correct header injection, reliable limit detection, task overview

let btnCheckInterval = null;
let usageFetchInterval = null;

// ── Context guards ────────────────────────────────────────────────────
function isCtxValid() {
  try { return !!(chrome?.runtime?.id); } catch { return false; }
}

function estimateTokens(text) {
  if (!text) return 0;
  const charCount = text.length;
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  if (charCount === 0) return 0;
  const tokens = Math.ceil((charCount / 4 + wordCount / 0.75) / 2);
  return Math.max(1, tokens);
}
function safeSend(msg, cb) {
  if (!isCtxValid()) return;
  try { chrome.runtime.sendMessage(msg, cb || (() => chrome.runtime.lastError)); }
  catch { selfDestruct(); }
}
function safeGet(key, cb) {
  if (!isCtxValid()) return;
  try { chrome.storage.local.get(key, cb); } catch { selfDestruct(); }
}
function safeSet(obj) {
  if (!isCtxValid()) return;
  try { chrome.storage.local.set(obj); } catch {}
}
function selfDestruct() {
  try { mutObs.disconnect(); } catch {}
  try { clearInterval(pollInterval); } catch {}
  try { clearInterval(convStatsInterval); } catch {}
  try { clearInterval(btnCheckInterval); } catch {}
  try { clearInterval(usageFetchInterval); } catch {}
  try { document.getElementById("ar-btn")?.remove(); } catch {}
  try { document.getElementById("ar-panel")?.remove(); } catch {}
  try { document.getElementById("ar-styles")?.remove(); } catch {}
  try { document.getElementById("ar-input-counter")?.remove(); } catch {}
  try { document.getElementById("ar-conv-stats")?.remove(); } catch {}
  try { document.getElementById("ar-page-usage-bar")?.remove(); } catch {}
}

// ── Message handler ───────────────────────────────────────────────────
try {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!isCtxValid()) return;
    if (msg.type === "CHECK_LIMIT") {
      const limited = isLimitActive();
      const canType = canSend();
      sendResponse({ limited, canType });
      return;
    }
    if (msg.type === "CHECK_AND_SEND") {
      doSend(msg.prompt).then(sendResponse);
      return true;
    }
    if (msg.type === "STATE_UPDATED") {
      renderUI(msg.state);
      return;
    }
    if (msg.type === "GET_RESET_INFO") {
      const ri = getResetInfo();
      sendResponse(ri || { mins: null });
      return;
    }
    if (msg.type === "GET_USAGE_INFO") {
      sendResponse(getUsageInfo());
      return;
    }
    if (msg.type === "TOGGLE_PANEL") {
      togglePanel();
      return;
    }
    if (msg.type === "TOGGLE_AUTORESUME") {
      // If active, stop. Otherwise open panel for user to start.
      safeGet("resumeState", d => {
        if (d?.resumeState?.active) {
          safeSend({ type: "STOP_RESUME" }, () => showToast("⏹ AutoResume stopped"));
        } else {
          if (!panelOpen) openPanel();
          showToast("Open panel — configure and click Start");
        }
      });
      return;
    }
    if (msg.type === "PLAY_NOTIFICATION_SOUND") {
      safeGet("soundEnabled", d => {
        if (d?.soundEnabled !== false) playNotificationChime();
      });
      return;
    }
  });
} catch {}

let latestUsageData = null;

function getOrgIdFromCookie() {
  try {
    return document.cookie
      .split('; ')
      .find((row) => row.startsWith('lastActiveOrg='))
      ?.split('=')[1] || null;
  } catch {
    return null;
  }
}

let cachedUsage = null;
let lastUsageFetchTime = 0;

async function fetchClaudeUsage() {
  const orgId = getOrgIdFromCookie();
  if (!orgId) return null;
  
  const now = Date.now();
  if (cachedUsage && (now - lastUsageFetchTime < 15000)) {
    return cachedUsage;
  }
  
  try {
    const res = await fetch(`https://claude.ai/api/organizations/${orgId}/usage`);
    if (!res.ok) return null;
    const data = await res.json();
    
    const info = { session: null, weekly: null };
    
    if (data.five_hour && typeof data.five_hour.utilization === 'number') {
      info.session = {
        pct: Math.round(data.five_hour.utilization),
        reset: data.five_hour.resets_at ? parseResetTimeFromIso(data.five_hour.resets_at) : null
      };
    }
    if (data.seven_day && typeof data.seven_day.utilization === 'number') {
      info.weekly = {
        pct: Math.round(data.seven_day.utilization),
        reset: data.seven_day.resets_at ? parseResetTimeFromIso(data.seven_day.resets_at) : null
      };
    }
    
    cachedUsage = info;
    lastUsageFetchTime = now;
    return info;
  } catch (err) {
    console.error("AutoResume usage fetch error:", err);
    return null;
  }
}

async function runPeriodicUsageFetch() {
  if (!isCtxValid()) return;
  const data = await fetchClaudeUsage();
  if (data) {
    latestUsageData = data;
    updateUsageBarOnPage();
    // Refresh setup/status UI if panel is open
    const activeTab = document.querySelector(".ar-tab.active")?.dataset?.tab;
    if (activeTab === "status") {
      refreshStatus();
    }
  }
}

// ── Limit & input detection ───────────────────────────────────────────
function isLimitActive() {
  try {
    if (latestUsageData?.session?.pct >= 100) return true;

    const body = document.body.innerText.toLowerCase();

    // Check for explicit limit phrases
    const limitPhrases = [
      "usage limit reached", "you've reached your limit",
      "try again in", "out of messages", "limit reached",
      "over the limit", "you've hit your", "out of free messages",
      "messages until"
    ];
    if (limitPhrases.some(p => body.includes(p))) return true;

    // Session bar shows 100% AND input is not editable = limited
    const input = getInput();
    if (input) {
      const editable = input.getAttribute("contenteditable");
      if (editable === "false" || editable === null) return true;
      // Check if input is visually blocked
      const style = window.getComputedStyle(input);
      if (style.pointerEvents === "none") return true;
    }

    // Check for disabled send button with no text in box
    const sendBtn = getSendBtn();
    if (sendBtn && sendBtn.disabled && !getInput()?.innerText?.trim()) {
      // Could mean limit — also check session bar
      if (body.includes("session: 100%") || body.match(/session:\s*100%/)) return true;
    }

    return false;
  } catch { return false; }
}

function canSend() {
  try {
    const input = getInput();
    if (!input) return false;
    const editable = input.getAttribute("contenteditable");
    if (editable !== "true") return false;
    const style = window.getComputedStyle(input);
    if (style.pointerEvents === "none") return false;
    if (isLimitActive()) return false;
    return true;
  } catch { return false; }
}

function getInput() {
  return (
    document.querySelector('div[contenteditable="true"][data-placeholder]') ||
    document.querySelector("div.ProseMirror[contenteditable='true']") ||
    document.querySelector('div[contenteditable="true"]')
  );
}

function getSendBtn() {
  const sels = [
    'button[aria-label="Send message"]',
    'button[aria-label="Send Message"]',
    'button[data-testid="send-button"]',
    'button[aria-label*="Send" i]',
  ];
  for (const s of sels) {
    const b = document.querySelector(s);
    if (b) return b;
  }
  return null;
}

// ── Auto-read reset timer ─────────────────────────────────────────────
function parseAbsoluteResetTime(text) {
  const m = text.match(/until\s+(\d+)(?::(\d+))?\s*(am|pm|a\.m\.|p\.m\.)/i);
  if (m) {
    let hour = parseInt(m[1]);
    const min = m[2] ? parseInt(m[2]) : 0;
    let ampm = m[3].toLowerCase().replace(/\./g, '');
    if (ampm === "pm" && hour < 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;
    const now = new Date();
    const resetDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, min, 0, 0);
    if (resetDate <= now) {
      resetDate.setDate(resetDate.getDate() + 1);
    }
    const diffMins = Math.max(1, Math.ceil((resetDate - now) / 60000));
    return { mins: diffMins, display: `until ${m[1]}${m[2] ? ":" + m[2] : ""} ${ampm.toUpperCase()}` };
  }
  const m24 = text.match(/until\s+(\d{1,2}):(\d{2})/i);
  if (m24) {
    const hour = parseInt(m24[1]);
    const min = parseInt(m24[2]);
    const now = new Date();
    const resetDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, min, 0, 0);
    if (resetDate <= now) {
      resetDate.setDate(resetDate.getDate() + 1);
    }
    const diffMins = Math.max(1, Math.ceil((resetDate - now) / 60000));
    return { mins: diffMins, display: `until ${hour.toString().padStart(2, '0')}:${min.toString().padStart(2, '0')}` };
  }
  return null;
}

function parseResetTimeFromIso(isoString) {
  try {
    const resetTime = new Date(isoString);
    const now = new Date();
    const diffMs = resetTime - now;
    if (diffMs <= 0) return null;
    const mins = Math.max(1, Math.ceil(diffMs / 60000));
    let display = "";
    if (mins >= 24 * 60) {
      const days = Math.floor(mins / (24 * 60));
      const hours = Math.floor((mins % (24 * 60)) / 60);
      display = `${days}d ${hours}h`;
    } else if (mins >= 60) {
      const hours = Math.floor(mins / 60);
      const remMins = mins % 60;
      display = `${hours}h ${remMins}m`;
    } else {
      display = `${mins}m`;
    }
    return { mins, display };
  } catch {
    return null;
  }
}

function parseResetTime(text) {
  const abs = parseAbsoluteResetTime(text);
  if (abs) return abs;

  const patterns = [
    /resets\s+in\s+(\d+)d\s+(\d+)h/i,
    /resets\s+in\s+(\d+)h\s+(\d+)m/i,
    /resets\s+in\s+(\d+)h/i,
    /resets\s+in\s+(\d+)m/i,
    /try\s+again\s+in\s+(\d+)h\s+(\d+)m/i,
    /try\s+again\s+in\s+(\d+)m/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (!m) continue;
    let mins = 0;
    const src = p.source;
    if (src.includes("\\d+)d")) {
      mins = parseInt(m[1]) * 24 * 60 + parseInt(m[2] || 0) * 60;
    } else if (src.includes("\\d+)h\\s+(\\d+)m")) {
      mins = parseInt(m[1]) * 60 + parseInt(m[2] || 0);
    } else if (src.includes("\\d+)h")) {
      mins = parseInt(m[1]) * 60;
    } else {
      mins = parseInt(m[1]);
    }
    if (mins > 0) {
      const raw = m[0].replace(/^(resets|try again)\s+in\s+/i, "").trim();
      return { mins, display: raw };
    }
  }
  return null;
}

function getUsageInfo() {
  if (latestUsageData) {
    return latestUsageData;
  }
  const info = { session: null, weekly: null };
  try {
    const leafEls = Array.from(document.querySelectorAll("*"))
      .filter(el => el.childElementCount === 0 && el.textContent.trim().length > 0);

    for (const el of leafEls) {
      const t = el.textContent.trim();

      // Match "Session: X%" or "Session: X% · resets in ..."
      const sessionMatch = t.match(/session[:\s]+(\d+)%/i);
      if (sessionMatch) {
        info.session = info.session || {};
        info.session.pct = parseInt(sessionMatch[1]);
        const resetPart = parseResetTime(t);
        if (resetPart) {
          info.session.reset = resetPart;
        }
      }

      // Match "Weekly: X%" or "Weekly: X% · resets in ..."
      const weeklyMatch = t.match(/weekly[:\s]+(\d+)%/i);
      if (weeklyMatch) {
        info.weekly = info.weekly || {};
        info.weekly.pct = parseInt(weeklyMatch[1]);
        const resetPart = parseResetTime(t);
        if (resetPart) {
          info.weekly.reset = resetPart;
        }
      }
    }

    // Also scan for standalone "resets in" near session/weekly labels
    if (info.session && !info.session.reset) {
      for (const el of leafEls) {
        const t = el.textContent.trim();
        if (/resets\s+in/i.test(t) && !(/weekly/i.test(t))) {
          const r = parseResetTime(t);
          if (r && r.mins < 24 * 60) { // Session resets are usually < 24h
            info.session.reset = r;
            break;
          }
        }
      }
    }
  } catch {}
  return info;
}

function getResetInfo() {
  try {
    const usage = getUsageInfo();

    // Prioritize session reset (the one that actually blocks you)
    if (usage.session?.reset) {
      return { mins: usage.session.reset.mins, display: usage.session.reset.display, source: "session" };
    }

    // Fall back to "try again in" text anywhere on page (limit banner)
    const body = document.body.innerText;
    const bannerReset = parseResetTime(body);
    if (bannerReset && bannerReset.mins < 24 * 60) {
      return { mins: bannerReset.mins, display: bannerReset.display, source: "banner" };
    }

    // Do NOT return the weekly reset — it's not useful for AutoResume
    return null;
  } catch {}
  return null;
}

// ── Prompt Templates ──────────────────────────────────────────────────
const BUILTIN_TEMPLATES = [
  { name: "Continue", prompt: "Continue from where we left off. Next step:" },
  { name: "Continue coding", prompt: "Continue coding from where we left off. Pick up the next task and implement it." },
  { name: "Summarize", prompt: "Summarize our progress so far and outline the remaining tasks." },
  { name: "Debug", prompt: "Debug the last error we encountered. Analyze the issue and provide a fix." },
];

function getTemplates(cb) {
  safeGet("customTemplates", d => {
    const custom = d?.customTemplates || [];
    cb([...BUILTIN_TEMPLATES, ...custom]);
  });
}

function saveCustomTemplate(name, prompt) {
  safeGet("customTemplates", d => {
    const arr = d?.customTemplates || [];
    arr.push({ name, prompt, custom: true });
    if (arr.length > 10) arr.shift();
    safeSet({ customTemplates: arr });
  });
}

function removeCustomTemplate(idx) {
  safeGet("customTemplates", d => {
    const arr = d?.customTemplates || [];
    arr.splice(idx, 1);
    safeSet({ customTemplates: arr });
  });
}

// ── Notification Sound ────────────────────────────────────────────────
function playNotificationChime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const notes = [523.25, 659.25, 783.99]; // C5, E5, G5 chord arpeggio
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, ctx.currentTime + i * 0.12);
      gain.gain.setValueAtTime(0.15, ctx.currentTime + i * 0.12);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.12 + 0.5);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime + i * 0.12);
      osc.stop(ctx.currentTime + i * 0.12 + 0.5);
    });
    setTimeout(() => ctx.close(), 2000);
  } catch {}
}

// ── Conversation Stats ────────────────────────────────────────────────
let convStatsVisible = false;
let convStatsInterval = null;

function countConversationStats() {
  try {
    const userMsgs = document.querySelectorAll('[data-testid*="user-message"], .font-user-message, [data-is-streaming="false"]');
    const allMsgBlocks = document.querySelectorAll('[data-testid*="message"], .font-claude-message, .font-user-message');
    let totalText = "";
    allMsgBlocks.forEach(el => { totalText += (el.innerText || "") + " "; });
    const userCount = Math.max(
      userMsgs.length,
      document.querySelectorAll('[class*="user"]').length > 0
        ? document.querySelectorAll('div[data-testid]').length / 2
        : 0
    );
    // Fallback: count by alternating message containers
    const msgContainers = document.querySelectorAll('div.group\\/conversation-turn');
    const actualCount = msgContainers.length || Math.ceil(userCount);

    const tokens = estimateTokens(totalText);
    return { messages: actualCount, tokens, textLength: totalText.length };
  } catch {
    return { messages: 0, tokens: 0, textLength: 0 };
  }
}

function showConvStats() {
  if (document.getElementById("ar-conv-stats")) return;
  convStatsVisible = true;
  safeSet({ convStatsVisible: true });

  function render() {
    const stats = countConversationStats();
    let el = document.getElementById("ar-conv-stats");
    if (!el) {
      el = document.createElement("div");
      el.id = "ar-conv-stats";
      document.body.appendChild(el);
    }
    el.innerHTML = `
      <span class="ar-cs-item"><span class="ar-cs-icon">💬</span><span class="ar-cs-val">${stats.messages}</span> msgs</span>
      <span class="ar-cs-item"><span class="ar-cs-icon">🔤</span><span class="ar-cs-val">~${stats.tokens > 1000 ? (stats.tokens / 1000).toFixed(1) + "k" : stats.tokens}</span> tokens</span>
      <button class="ar-cs-close" id="ar-cs-close">✕</button>
    `;
    el.querySelector("#ar-cs-close").onclick = hideConvStats;
  }

  render();
  convStatsInterval = setInterval(render, 5000);
}

function hideConvStats() {
  convStatsVisible = false;
  safeSet({ convStatsVisible: false });
  document.getElementById("ar-conv-stats")?.remove();
  if (convStatsInterval) { clearInterval(convStatsInterval); convStatsInterval = null; }
}

// ── Usage History & Sparkline ─────────────────────────────────────────
function recordUsageSnapshot() {
  const usage = getUsageInfo();
  if (!usage.session && !usage.weekly) return;
  safeGet("usageHistory", d => {
    const history = d?.usageHistory || [];
    history.push({
      t: Date.now(),
      s: usage.session?.pct ?? null,
      w: usage.weekly?.pct ?? null,
    });
    if (history.length > 50) history.splice(0, history.length - 50);
    safeSet({ usageHistory: history });
  });
}

function renderSparkline(containerId) {
  safeGet("usageHistory", d => {
    const el = document.getElementById(containerId);
    if (!el) return;
    const history = d?.usageHistory || [];
    if (history.length < 2) {
      el.innerHTML = `<div class="ar-sparkline-title">Usage Trend</div>
        <div style="font-size:10px;color:#3e3e50;text-align:center;padding:8px 0;">Not enough data yet</div>`;
      return;
    }

    const pts = history.map(h => h.s ?? 0);
    const max = Math.max(...pts, 100);
    const w = 300, h = 36;
    const step = w / (pts.length - 1);

    const pathD = pts.map((v, i) => {
      const x = i * step;
      const y = h - (v / max) * h;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");

    const areaD = pathD + ` L${w},${h} L0,${h} Z`;

    el.innerHTML = `
      <div class="ar-sparkline-title">Session Usage Trend</div>
      <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
        <defs>
          <linearGradient id="ar-sg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#7c3aed" stop-opacity="0.3"/>
            <stop offset="100%" stop-color="#7c3aed" stop-opacity="0"/>
          </linearGradient>
        </defs>
        <path d="${areaD}" fill="url(#ar-sg)" />
        <path d="${pathD}" fill="none" stroke="#a78bfa" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        <circle cx="${(pts.length - 1) * step}" cy="${h - (pts[pts.length - 1] / max) * h}" r="2.5" fill="#a78bfa"/>
      </svg>
    `;
  });
}

// ── Export/Import Settings ─────────────────────────────────────────────
function exportSettings() {
  safeGet(["savedSettings", "customTemplates", "usageHistory"], d => {
    const data = {
      version: "1.0.0",
      exportedAt: new Date().toISOString(),
      savedSettings: d.savedSettings || {},
      customTemplates: d.customTemplates || [],
      usageHistory: d.usageHistory || [],
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `autoresume-settings-${Date.now()}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    showToast("✓ Settings exported");
  });
}

function importSettings() {
  const input = document.createElement("input");
  input.type = "file"; input.accept = ".json";
  input.onchange = e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const data = JSON.parse(ev.target.result);
        if (data.savedSettings) safeSet({ savedSettings: data.savedSettings });
        if (data.customTemplates) safeSet({ customTemplates: data.customTemplates });
        if (data.usageHistory) safeSet({ usageHistory: data.usageHistory });
        showToast("✓ Settings imported — reopen panel");
        closePanel();
      } catch { showToast("⚠ Invalid settings file"); }
    };
    reader.readAsText(file);
  };
  input.click();
}

// ── Auto-Save Draft ───────────────────────────────────────────────────
let draftSaveTimeout = null;
function autoSaveDraft(prompt, url) {
  clearTimeout(draftSaveTimeout);
  draftSaveTimeout = setTimeout(() => {
    safeGet("savedSettings", d => {
      const existing = d?.savedSettings || {};
      safeSet({ savedSettings: { ...existing, prompt, chatUrl: url || existing.chatUrl || "" } });
    });
  }, 1200);
}

// ── Send prompt ───────────────────────────────────────────────────────
async function doSend(prompt) {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  if (!canSend()) return { sent: false, reason: isLimitActive() ? "still_limited" : "not_ready" };

  const box = getInput();
  if (!box) return { sent: false, reason: "no_input" };

  box.focus();
  await wait(300);
  document.execCommand("selectAll", false, null);
  document.execCommand("delete", false, null);
  await wait(200);
  document.execCommand("insertText", false, prompt);
  await wait(800);

  // Verify insertion
  if (!(box.innerText || "").trim()) {
    const dt = new DataTransfer();
    dt.setData("text/plain", prompt);
    box.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
    await wait(800);
  }
  if (!(box.innerText || "").trim()) return { sent: false, reason: "insert_failed" };

  await wait(300);

  // Click send button
  const btn = getSendBtn();
  if (btn && !btn.disabled) {
    btn.click();
    await wait(600);
    return { sent: true, method: "button" };
  }

  // Enter key fallback
  box.focus();
  ["keydown", "keypress", "keyup"].forEach(t =>
    box.dispatchEvent(new KeyboardEvent(t, {
      key: "Enter", code: "Enter", keyCode: 13,
      which: 13, bubbles: true, cancelable: true
    }))
  );
  await wait(600);
  return { sent: true, method: "enter" };
}

// ── Styles ────────────────────────────────────────────────────────────
function injectStyles() {
  if (document.getElementById("ar-styles")) return;
  const el = document.createElement("style");
  el.id = "ar-styles";
  el.textContent = `
    /* Header button */
    #ar-btn {
      width: 32px;
      height: 32px;
      border-radius: 9px;
      border: 1px solid rgba(124, 58, 237, 0.22);
      background: rgba(124, 58, 237, 0.05);
      cursor: pointer;
      color: #6d28d9; /* Deep violet for light theme */
      display: inline-flex;
      align-items: center;
      justify-content: center;
      position: relative;
      flex-shrink: 0;
      transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
      vertical-align: middle;
      box-shadow: 0 1px 2px rgba(124, 58, 237, 0.08);
    }
    #ar-btn:hover {
      background: rgba(124, 58, 237, 0.12);
      border-color: rgba(124, 58, 237, 0.45);
      color: #5b21b6;
      box-shadow: 0 0 10px rgba(124, 58, 237, 0.2);
      transform: translateY(-1px);
    }
    
    /* Dark mode override */
    .dark #ar-btn, [class*="dark"] #ar-btn {
      color: #a78bfa; /* Lighter violet for dark mode */
      border-color: rgba(167, 139, 250, 0.3);
      background: rgba(167, 139, 250, 0.07);
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
    }
    .dark #ar-btn:hover, [class*="dark"] #ar-btn:hover {
      color: #c084fc;
      border-color: rgba(167, 139, 250, 0.5);
      background: rgba(167, 139, 250, 0.15);
      box-shadow: 0 0 10px rgba(167, 139, 250, 0.25);
    }

    #ar-btn:active {
      transform: translateY(0);
    }
    #ar-btn svg {
      width: 18px;
      height: 18px;
      pointer-events: none;
      transition: color 0.25s;
    }
    #ar-btn:hover svg {
      color: currentColor;
    }
    #ar-btn:hover svg .ar-outer-ring {
      animation: ar-spin-ring 12s linear infinite;
    }
    #ar-btn:hover svg .ar-tick-hand {
      transform-origin: 12px 12px;
      transform: rotate(20deg);
    }
    @keyframes ar-spin-ring {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    #ar-badge {
      position:absolute; top:5px; right:5px; width:7px; height:7px;
      border-radius:50%; border:1.5px solid #1a1a1e; display:none;
    }

    /* State styles (Light Theme) */
    #ar-btn.s-mon {
      color: #059669; border-color: rgba(5, 150, 105, 0.35); background: rgba(5, 150, 105, 0.06);
    }
    #ar-btn.s-mon:hover {
      color: #047857; border-color: rgba(5, 150, 105, 0.55); background: rgba(5, 150, 105, 0.12);
      box-shadow: 0 0 10px rgba(5, 150, 105, 0.2);
    }
    #ar-btn.s-mon #ar-badge { display:block; background:#10b981; border-color:#fff; animation:ar-p 2s infinite; }

    #ar-btn.s-wait {
      color: #d97706; border-color: rgba(217, 119, 6, 0.35); background: rgba(217, 119, 6, 0.06);
    }
    #ar-btn.s-wait:hover {
      color: #b45309; border-color: rgba(217, 119, 6, 0.55); background: rgba(217, 119, 6, 0.12);
      box-shadow: 0 0 10px rgba(217, 119, 6, 0.2);
    }
    #ar-btn.s-wait #ar-badge { display:block; background:#f59e0b; border-color:#fff; animation:ar-p 2s infinite; }

    #ar-btn.s-chk {
      color: #2563eb; border-color: rgba(37, 99, 235, 0.35); background: rgba(37, 99, 235, 0.06);
    }
    #ar-btn.s-chk:hover {
      color: #1d4ed8; border-color: rgba(37, 99, 235, 0.55); background: rgba(37, 99, 235, 0.12);
      box-shadow: 0 0 10px rgba(37, 99, 235, 0.2);
    }
    #ar-btn.s-chk #ar-badge { display:block; background:#3b82f6; border-color:#fff; animation:ar-p 0.7s infinite; }

    #ar-btn.s-done {
      color: #059669; border-color: rgba(5, 150, 105, 0.35); background: rgba(5, 150, 105, 0.06);
    }
    #ar-btn.s-done:hover {
      color: #047857; border-color: rgba(5, 150, 105, 0.55); background: rgba(5, 150, 105, 0.12);
      box-shadow: 0 0 10px rgba(5, 150, 105, 0.2);
    }
    #ar-btn.s-done #ar-badge { display:block; background:#10b981; border-color:#fff; }

    /* State styles (Dark Theme) */
    .dark #ar-btn.s-mon, [class*="dark"] #ar-btn.s-mon {
      color: #34d399; border-color: rgba(52, 211, 153, 0.35); background: rgba(52, 211, 153, 0.08);
    }
    .dark #ar-btn.s-mon:hover, [class*="dark"] #ar-btn.s-mon:hover {
      color: #6ee7b7; border-color: rgba(52, 211, 153, 0.55); background: rgba(52, 211, 153, 0.15);
      box-shadow: 0 0 10px rgba(52, 211, 153, 0.25);
    }
    .dark #ar-btn.s-mon #ar-badge, [class*="dark"] #ar-btn.s-mon #ar-badge { border-color:#1a1a1e; }

    .dark #ar-btn.s-wait, [class*="dark"] #ar-btn.s-wait {
      color: #fbbf24; border-color: rgba(251, 191, 36, 0.35); background: rgba(251, 191, 36, 0.08);
    }
    .dark #ar-btn.s-wait:hover, [class*="dark"] #ar-btn.s-wait:hover {
      color: #fde047; border-color: rgba(251, 191, 36, 0.55); background: rgba(251, 191, 36, 0.15);
      box-shadow: 0 0 10px rgba(251, 191, 36, 0.25);
    }
    .dark #ar-btn.s-wait #ar-badge, [class*="dark"] #ar-btn.s-wait #ar-badge { border-color:#1a1a1e; }

    .dark #ar-btn.s-chk, [class*="dark"] #ar-btn.s-chk {
      color: #60a5fa; border-color: rgba(96, 165, 250, 0.35); background: rgba(96, 165, 250, 0.08);
    }
    .dark #ar-btn.s-chk:hover, [class*="dark"] #ar-btn.s-chk:hover {
      color: #93c5fd; border-color: rgba(96, 165, 250, 0.55); background: rgba(96, 165, 250, 0.15);
      box-shadow: 0 0 10px rgba(96, 165, 250, 0.25);
    }
    .dark #ar-btn.s-chk #ar-badge, [class*="dark"] #ar-btn.s-chk #ar-badge { border-color:#1a1a1e; }

    .dark #ar-btn.s-done, [class*="dark"] #ar-btn.s-done {
      color: #34d399; border-color: rgba(52, 211, 153, 0.35); background: rgba(52, 211, 153, 0.08);
    }
    .dark #ar-btn.s-done:hover, [class*="dark"] #ar-btn.s-done:hover {
      color: #6ee7b7; border-color: rgba(52, 211, 153, 0.55); background: rgba(52, 211, 153, 0.15);
      box-shadow: 0 0 10px rgba(52, 211, 153, 0.25);
    }
    .dark #ar-btn.s-done #ar-badge, [class*="dark"] #ar-btn.s-done #ar-badge { border-color:#1a1a1e; }

    @keyframes ar-p { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:0.4;transform:scale(0.65)} }

    /* Floating Action Button (FAB) fallback */
    .ar-fab:hover {
      background: #6d28d9 !important;
      transform: translateY(-2px) scale(1.05) !important;
      box-shadow: 0 6px 20px rgba(109, 40, 217, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.2) !important;
    }
    .ar-fab:active {
      transform: translateY(0) scale(0.98) !important;
    }
    .ar-fab svg {
      width: 20px !important;
      height: 20px !important;
      color: #ffffff !important;
    }

    /* FAB state overrides */
    .ar-fab.s-mon {
      background: #10b981 !important;
      box-shadow: 0 4px 16px rgba(16, 185, 129, 0.4) !important;
    }
    .ar-fab.s-mon:hover {
      background: #059669 !important;
      box-shadow: 0 6px 20px rgba(5, 150, 105, 0.5) !important;
    }

    .ar-fab.s-wait {
      background: #f59e0b !important;
      box-shadow: 0 4px 16px rgba(245, 158, 11, 0.4) !important;
    }
    .ar-fab.s-wait:hover {
      background: #d97706 !important;
      box-shadow: 0 6px 20px rgba(217, 119, 6, 0.5) !important;
    }

    .ar-fab.s-chk {
      background: #3b82f6 !important;
      box-shadow: 0 4px 16px rgba(59, 130, 246, 0.4) !important;
    }
    .ar-fab.s-chk:hover {
      background: #2563eb !important;
      box-shadow: 0 6px 20px rgba(37, 99, 235, 0.5) !important;
    }

    .ar-fab.s-done {
      background: #10b981 !important;
      box-shadow: 0 4px 16px rgba(16, 185, 129, 0.4) !important;
    }
    .ar-fab.s-done:hover {
      background: #059669 !important;
      box-shadow: 0 6px 20px rgba(5, 150, 105, 0.5) !important;
    }

    /* Panel — drops down from top-right */
    #ar-panel {
      position:fixed; width:348px;
      background:#101014; border:1px solid rgba(255,255,255,0.1);
      border-radius:16px; z-index:2147483647;
      box-shadow:0 16px 56px rgba(0,0,0,0.75), 0 0 0 1px rgba(124,58,237,0.12);
      font-family:-apple-system,'Segoe UI',system-ui,sans-serif;
      overflow:hidden; animation:ar-drop 0.2s cubic-bezier(0.34,1.4,0.64,1);
    }
    @keyframes ar-drop {
      from{opacity:0;transform:translateY(-10px) scale(0.97)}
      to  {opacity:1;transform:translateY(0)     scale(1)}
    }

    /* Header */
    .ar-hd {
      display:flex; align-items:center; justify-content:space-between;
      padding:13px 15px 11px;
      border-bottom:1px solid rgba(255,255,255,0.06);
      background:linear-gradient(160deg,rgba(124,58,237,0.1) 0%,transparent 60%);
    }
    .ar-hd-l { display:flex; align-items:center; gap:10px; }
    .ar-ico {
      width:28px; height:28px; border-radius:7px; flex-shrink:0;
      background:linear-gradient(135deg,#7c3aed,#4c1d95);
      display:flex; align-items:center; justify-content:center;
    }
    .ar-ico svg { width:14px; height:14px; color:#fff; }
    .ar-ttl { font-size:13px; font-weight:600; color:#f0f0f4; }
    .ar-sub { font-size:10px; color:#5a5a6e; margin-top:1px; }
    .ar-cls {
      width:22px; height:22px; border-radius:6px; border:none;
      background:rgba(255,255,255,0.05); color:#5a5a6e; font-size:12px;
      cursor:pointer; display:flex; align-items:center; justify-content:center;
      transition:all 0.15s;
    }
    .ar-cls:hover { background:rgba(255,255,255,0.1); color:#f0f0f4; }

    /* Tabs */
    .ar-tabs {
      display:flex; border-bottom:1px solid rgba(255,255,255,0.06);
      padding:0 14px;
    }
    .ar-tab {
      padding:9px 12px 8px; font-size:11px; font-weight:500; color:#5a5a6e;
      border-bottom:2px solid transparent; cursor:pointer; transition:all 0.15s;
      user-select:none; letter-spacing:0.2px;
    }
    .ar-tab:hover { color:#9b9ba8; }
    .ar-tab.active { color:#a78bfa; border-bottom-color:#7c3aed; }

    /* Tab content */
    .ar-tab-body { display:none; padding:13px 14px 14px; }
    .ar-tab-body.active { display:flex; flex-direction:column; gap:10px; }

    /* Status card */
    .ar-sc {
      display:flex; align-items:flex-start; gap:9px; padding:10px 11px;
      border-radius:10px; background:rgba(255,255,255,0.03);
      border:1px solid rgba(255,255,255,0.06);
    }
    .ar-sc-dot {
      width:7px; height:7px; border-radius:50%; flex-shrink:0; margin-top:4px;
      background:#2e2e3e;
    }
    .ar-sc.s-mon  .ar-sc-dot { background:#4ade80; animation:ar-p 2s infinite; }
    .ar-sc.s-wait .ar-sc-dot { background:#facc15; animation:ar-p 2s infinite; }
    .ar-sc.s-chk  .ar-sc-dot { background:#60a5fa; animation:ar-p 0.7s infinite; }
    .ar-sc.s-done .ar-sc-dot { background:#4ade80; }
    .ar-sc.s-fail .ar-sc-dot { background:#f87171; }
    .ar-sc-info { flex:1; min-width:0; }
    .ar-sc-title { font-size:12px; font-weight:500; color:#d4d4e0; }
    .ar-sc-desc  { font-size:11px; color:#5a5a6e; margin-top:2px; line-height:1.5; }

    /* Progress */
    .ar-prog { margin-top:6px; }
    .ar-prog-bar { height:3px; background:rgba(255,255,255,0.06); border-radius:3px; overflow:hidden; }
    .ar-prog-fill { height:100%; background:linear-gradient(90deg,#7c3aed,#60a5fa);
      border-radius:3px; transition:width 3s ease; }
    .ar-prog-lbl { font-size:10px; color:#3e3e50; margin-top:4px; }

    /* Task info card */
    .ar-task {
      padding:10px 11px; border-radius:10px;
      background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.05);
    }
    .ar-task-row { display:flex; justify-content:space-between; align-items:center;
      margin-bottom:6px; }
    .ar-task-row:last-child { margin-bottom:0; }
    .ar-task-key { font-size:10px; color:#4a4a5e; text-transform:uppercase;
      letter-spacing:0.5px; font-weight:600; }
    .ar-task-val { font-size:11px; color:#9b9ba8; text-align:right;
      max-width:180px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .ar-task-val.green { color:#4ade80; }
    .ar-task-val.yellow { color:#facc15; }
    .ar-task-val.muted { color:#3e3e50; }

    /* Fields */
    .ar-lbl { font-size:10px; font-weight:600; letter-spacing:0.5px;
      text-transform:uppercase; color:#4a4a5e; margin-bottom:5px; display:block; }
    .ar-inp, .ar-txa {
      width:100%; background:#18181c; border:1px solid rgba(255,255,255,0.07);
      border-radius:8px; color:#e8e8f0; padding:8px 10px; font-family:inherit;
      font-size:12px; outline:none; resize:none; transition:border-color 0.15s,box-shadow 0.15s;
      box-sizing:border-box;
    }
    .ar-txa { height:68px; line-height:1.6; }
    .ar-inp:focus,.ar-txa:focus {
      border-color:rgba(124,58,237,0.5); box-shadow:0 0 0 3px rgba(124,58,237,0.08);
    }
    .ar-row2 { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
    .ar-hint { font-size:10px; color:#3a3a4e; margin-top:3px; }
    .ar-auto { font-size:10px; color:#4ade80; margin-top:3px; }

    /* URL row */
    .ar-url-r { display:flex; gap:6px; }
    .ar-url-r .ar-inp { flex:1; }
    .ar-grab {
      padding:0 10px; background:rgba(124,58,237,0.12);
      border:1px solid rgba(124,58,237,0.22); border-radius:8px;
      color:#a78bfa; font-size:11px; font-weight:500; cursor:pointer;
      white-space:nowrap; font-family:inherit; transition:background 0.15s; flex-shrink:0;
    }
    .ar-grab:hover { background:rgba(124,58,237,0.22); }

    /* Buttons */
    .ar-btn-primary {
      width:100%; padding:10px; border:none; border-radius:9px;
      background:linear-gradient(135deg,#7c3aed,#6d28d9);
      color:#fff; font-family:inherit; font-size:13px; font-weight:600;
      cursor:pointer; letter-spacing:0.1px;
      box-shadow:0 2px 14px rgba(124,58,237,0.3);
      transition:opacity 0.15s,transform 0.1s;
    }
    .ar-btn-primary:hover { opacity:0.88; }
    .ar-btn-primary:active { transform:scale(0.99); }
    .ar-btn-primary:disabled { opacity:0.3; cursor:not-allowed; transform:none; }
    .ar-btn-danger {
      width:100%; padding:9px; border:1px solid rgba(248,113,113,0.28);
      border-radius:9px; background:transparent; color:#fca5a5;
      font-family:inherit; font-size:12px; font-weight:500; cursor:pointer;
      transition:background 0.15s;
    }
    .ar-btn-danger:hover { background:rgba(248,113,113,0.07); }

    /* Log */
    .ar-log {
      background:#0c0c10; border:1px solid rgba(255,255,255,0.05);
      border-radius:9px; padding:10px; height:190px; overflow-y:auto;
      font-family:'Cascadia Code',Consolas,'SF Mono',monospace; font-size:10.5px;
      color:#4a4a5e; line-height:1.7;
    }
    .ar-log::-webkit-scrollbar { width:3px; }
    .ar-log::-webkit-scrollbar-thumb { background:#2a2a3e; border-radius:2px; }
    .ar-log-line { display:block; }
    .ar-log-line.ok  { color:#4ade80; }
    .ar-log-line.warn{ color:#facc15; }
    .ar-log-line.info{ color:#60a5fa; }
    .ar-log-line.err { color:#f87171; }

    /* Divider */
    .ar-div { height:1px; background:rgba(255,255,255,0.05); }

    /* Toast */
    #ar-toast {
      position:fixed; bottom:20px; left:50%;
      transform:translateX(-50%) translateY(8px);
      background:rgba(16,16,20,0.97); border:1px solid rgba(255,255,255,0.1);
      border-radius:100px; padding:7px 16px;
      font-family:-apple-system,'Segoe UI',sans-serif;
      font-size:12px; color:#e8e8f0; opacity:0; pointer-events:none;
      transition:all 0.2s; z-index:2147483647; white-space:nowrap;
      box-shadow:0 4px 24px rgba(0,0,0,0.6);
    }
    #ar-toast.show { opacity:1; transform:translateX(-50%) translateY(0); }

    /* Token counters */
    .ar-prompt-stats {
      font-size: 10px;
      color: #5a5a6e;
      text-align: right;
      margin-top: 4.5px;
      font-family: monospace;
      letter-spacing: 0.2px;
    }
    .ar-prompt-stats .stat-highlight {
      color: #a78bfa;
      font-weight: 600;
    }
    .ar-input-counter {
      position: absolute;
      bottom: 12px;
      left: 16px;
      font-size: 10px;
      font-weight: 600;
      color: rgba(255, 255, 255, 0.45);
      background: rgba(16, 16, 20, 0.85);
      border: 1px solid rgba(255, 255, 255, 0.08);
      padding: 3px 8px;
      border-radius: 6px;
      pointer-events: none;
      z-index: 9;
      font-family: monospace;
      backdrop-filter: blur(4px);
      transition: all 0.2s ease;
      box-shadow: 0 2px 8px rgba(0,0,0,0.4);
    }
    .ar-input-counter.active {
      color: #a78bfa;
      border-color: rgba(124, 58, 237, 0.25);
      background: rgba(124, 58, 237, 0.08);
    }

    /* Prompt Templates */
    .ar-templates {
      display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 6px;
    }
    .ar-tpl-chip {
      padding: 4px 10px; border-radius: 100px; border: 1px solid rgba(255,255,255,0.08);
      background: rgba(255,255,255,0.03); color: #8b8ba0; font-size: 10px;
      cursor: pointer; transition: all 0.15s; font-family: inherit; white-space: nowrap;
    }
    .ar-tpl-chip:hover {
      background: rgba(124,58,237,0.12); border-color: rgba(124,58,237,0.3); color: #a78bfa;
    }
    .ar-tpl-chip.custom { border-style: dashed; }
    .ar-tpl-del {
      margin-left: 5px; opacity: 0.5; font-weight: bold; cursor: pointer; transition: color 0.15s, opacity 0.15s;
    }
    .ar-tpl-del:hover {
      opacity: 1; color: #f87171 !important;
    }
    .ar-tpl-save {
      padding: 4px 8px; border-radius: 100px; border: 1px dashed rgba(74,222,128,0.25);
      background: transparent; color: #4ade80; font-size: 10px;
      cursor: pointer; transition: all 0.15s; font-family: inherit;
    }
    .ar-tpl-save:hover { background: rgba(74,222,128,0.08); }

    /* Settings Row (sound toggle, shortcuts) */
    .ar-settings-row {
      display: flex; align-items: center; justify-content: space-between;
      padding: 6px 0;
    }
    .ar-settings-label {
      font-size: 11px; color: #6a6a7e; display: flex; align-items: center; gap: 6px;
    }
    .ar-toggle {
      position: relative; width: 32px; height: 18px; appearance: none;
      background: #2a2a3e; border-radius: 9px; cursor: pointer;
      transition: background 0.2s; border: none; outline: none;
    }
    .ar-toggle:checked { background: #7c3aed; }
    .ar-toggle::after {
      content: ''; position: absolute; top: 2px; left: 2px;
      width: 14px; height: 14px; border-radius: 50%;
      background: #fff; transition: transform 0.2s;
    }
    .ar-toggle:checked::after { transform: translateX(14px); }

    /* Export/Import */
    .ar-export-row {
      display: flex; gap: 6px; margin-top: 4px;
    }
    .ar-btn-sm {
      flex: 1; padding: 6px 8px; border-radius: 7px;
      border: 1px solid rgba(255,255,255,0.08); background: rgba(255,255,255,0.03);
      color: #8b8ba0; font-size: 10px; font-weight: 500; cursor: pointer;
      font-family: inherit; transition: all 0.15s; text-align: center;
    }
    .ar-btn-sm:hover { background: rgba(255,255,255,0.06); color: #d4d4e0; }

    /* Sparkline */
    .ar-sparkline-wrap {
      padding: 8px 11px; border-radius: 10px;
      background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05);
    }
    .ar-sparkline-title {
      font-size: 10px; color: #4a4a5e; text-transform: uppercase;
      letter-spacing: 0.5px; font-weight: 600; margin-bottom: 6px;
    }
    .ar-sparkline svg { width: 100%; height: 40px; }

    /* Conversation Stats Overlay */
    #ar-conv-stats {
      position: fixed; bottom: 60px; right: 16px; z-index: 2147483640;
      background: rgba(16,16,20,0.92); border: 1px solid rgba(255,255,255,0.08);
      border-radius: 10px; padding: 8px 12px;
      font-family: -apple-system,'Segoe UI',sans-serif;
      font-size: 11px; color: #9b9ba8;
      backdrop-filter: blur(12px);
      box-shadow: 0 4px 20px rgba(0,0,0,0.5);
      display: flex; gap: 12px; align-items: center;
      transition: all 0.25s ease; cursor: default;
      opacity: 0.7;
    }
    #ar-conv-stats:hover { opacity: 1; border-color: rgba(124,58,237,0.25); }
    .ar-cs-item { display: flex; align-items: center; gap: 4px; }
    .ar-cs-icon { font-size: 10px; opacity: 0.6; }
    .ar-cs-val { color: #d4d4e0; font-weight: 500; font-family: monospace; font-size: 11px; }
    .ar-cs-close {
      width: 16px; height: 16px; border-radius: 4px; border: none;
      background: rgba(255,255,255,0.06); color: #5a5a6e; font-size: 9px;
      cursor: pointer; display: flex; align-items: center; justify-content: center;
      transition: all 0.15s; margin-left: 2px;
    }
    .ar-cs-close:hover { background: rgba(255,255,255,0.12); color: #f0f0f4; }

    /* Keyboard shortcut hint */
    .ar-shortcut {
      font-size: 9px; color: #3a3a4e; font-family: monospace;
      padding: 1px 4px; border: 1px solid rgba(255,255,255,0.06);
      border-radius: 3px; background: rgba(255,255,255,0.02);
    }

    /* Force hide she-llac/claude-counter elements to prevent overlaps */
    [class*="cc-"],
    [id*="cc-"],
    .cc-tooltip,
    .cc-tooltipTrigger,
    .cc-header,
    .cc-headerItem,
    .cc-usageRow,
    .cc-usageGroup,
    .cc-usageText,
    .cc-bar {
      display: none !important;
    }

    /* Sleek Native Usage progress bar below composer */
    .ar-page-usage-bar {
      width: 100%;
      margin-top: 8px;
      margin-bottom: 4px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      user-select: none;
    }
    .ar-pub-row {
      display: flex;
      gap: 16px;
      width: 100%;
    }
    .ar-pub-col {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 0;
    }
    .ar-pub-meta {
      display: flex;
      align-items: center;
      font-size: 11px;
      line-height: 1;
    }
    .ar-pub-label {
      color: #8b8ba0;
      font-weight: 500;
      margin-right: 4px;
    }
    .ar-pub-pct {
      font-weight: 600;
      color: #e8e8f0;
    }
    .light .ar-pub-pct, [class*="light"] .ar-pub-pct {
      color: #1a1a1e;
    }
    .ar-pub-reset {
      color: #5a5a6e;
      font-size: 10px;
      margin-left: 6px;
      font-family: monospace;
    }
    .ar-pub-progress-bg {
      height: 4px;
      background: rgba(255, 255, 255, 0.08);
      border-radius: 2px;
      overflow: hidden;
      width: 100%;
    }
    .light .ar-pub-progress-bg, [class*="light"] .ar-pub-progress-bg {
      background: rgba(0, 0, 0, 0.06);
    }
    .ar-pub-progress-fill {
      height: 100%;
      border-radius: 2px;
      transition: width 0.4s cubic-bezier(0.4, 0, 0.2, 1), background-color 0.3s;
      width: 0%;
    }
    .ar-pub-fill-green {
      background: #10b981;
    }
    .ar-pub-fill-yellow {
      background: #f59e0b;
    }
    .ar-pub-fill-red {
      background: #ef4444;
    }
    .ar-pub-fill-blue {
      background: #3b82f6;
    }
  `;
  document.head.appendChild(el);
}

function hasHeaderAnchor() {
  const shareBtn = Array.from(document.querySelectorAll("button, div[role='button'], a, span"))
    .find(el => el.textContent?.trim() === "Share" && el.getBoundingClientRect().top < 100 && el.getBoundingClientRect().height > 0);
  if (shareBtn && shareBtn.parentElement) return true;

  const upgradeBtn = Array.from(document.querySelectorAll("button, div[role='button'], a, span"))
    .find(el => el.textContent?.trim()?.toLowerCase()?.includes("upgrade") && el.getBoundingClientRect().top < 100 && el.getBoundingClientRect().height > 0);
  if (upgradeBtn && upgradeBtn.parentElement) return true;

  const allBtns = Array.from(document.querySelectorAll("button"));
  const vpW = window.innerWidth;
  const topRightBtns = allBtns.filter(b => {
    const r = b.getBoundingClientRect();
    return r.top < 80 && r.top >= 0 && r.left > vpW * 0.4 && r.width > 0 && r.height > 0;
  });
  if (topRightBtns.length > 0) return true;

  return false;
}

// ── Inject button into Claude header ─────────────────────────────────
function shouldShowBtn() {
  const url = window.location.href;
  return !url.includes("/login") && !url.includes("/signup");
}

function injectBtn() {
  if (!shouldShowBtn()) {
    document.getElementById("ar-btn")?.remove();
    return;
  }
  // Check if button exists AND is still connected to the DOM
  // (SPA navigation can detach elements without removing them from memory)
  const existing = document.getElementById("ar-btn");
  if (existing && existing.isConnected) return;
  if (existing && !existing.isConnected) existing.remove();

  const btn = document.createElement("button");
  btn.id    = "ar-btn";
  btn.title = "AutoResume";
  btn.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <circle class="ar-outer-ring" cx="12" cy="12" r="10" stroke-dasharray="3 3" stroke-opacity="0.4" style="transform-origin: 12px 12px;" />
      <circle cx="12" cy="12" r="8" />
      <path class="ar-tick-hand" d="M12 7v5l3 2" style="transform-origin: 12px 12px;" />
    </svg>
    <span id="ar-badge"></span>
  `;
  btn.onclick = e => { e.stopPropagation(); togglePanel(); };

  function tryInsert() {
    // Strategy 1: Find "Share" button in header (highly reliable on chat pages)
    const shareBtn = Array.from(document.querySelectorAll("button, div[role='button'], a, span"))
      .find(el => el.textContent?.trim() === "Share" && el.getBoundingClientRect().top < 100 && el.getBoundingClientRect().height > 0);
    if (shareBtn && shareBtn.parentElement) {
      btn.className = "";
      btn.style.cssText = "";
      shareBtn.parentElement.insertBefore(btn, shareBtn);
      return true;
    }

    // Strategy 2: Find "Upgrade" button in header
    const upgradeBtn = Array.from(document.querySelectorAll("button, div[role='button'], a, span"))
      .find(el => el.textContent?.trim()?.toLowerCase()?.includes("upgrade") && el.getBoundingClientRect().top < 100 && el.getBoundingClientRect().height > 0);
    if (upgradeBtn && upgradeBtn.parentElement) {
      btn.className = "";
      btn.style.cssText = "";
      upgradeBtn.parentElement.insertBefore(btn, upgradeBtn);
      return true;
    }

    // Strategy 3: Find any buttons in the top-right header area
    const allBtns = Array.from(document.querySelectorAll("button"));
    const vpW = window.innerWidth;
    const topRightBtns = allBtns.filter(b => {
      const r = b.getBoundingClientRect();
      return r.top < 80 && r.top >= 0 && r.left > vpW * 0.4 && r.width > 0 && r.height > 0;
    });

    if (topRightBtns.length > 0) {
      topRightBtns.sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left);
      const anchor = topRightBtns[0];
      if (anchor?.parentElement) {
        btn.className = "";
        btn.style.cssText = "";
        anchor.parentElement.insertBefore(btn, anchor);
        return true;
      }
    }

    // Strategy 4: Find header/nav elements and append to container
    const headerEls = document.querySelectorAll('header, nav, [role="banner"], [data-testid="header"]');
    for (const hdr of headerEls) {
      const r = hdr.getBoundingClientRect();
      if (r.top < 80 && r.height > 0 && r.height < 100) {
        const containers = hdr.querySelectorAll('div, span');
        const rightmost = Array.from(containers)
          .filter(c => {
            const cr = c.getBoundingClientRect();
            return cr.left > vpW * 0.6 && cr.width > 0 && cr.height > 0;
          })
          .sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left);
        if (rightmost[0]) {
          btn.className = "";
          btn.style.cssText = "";
          rightmost[0].appendChild(btn);
          return true;
        }
      }
    }

    return false;
  }

  // Try immediately
  if (tryInsert()) {
    safeGet("resumeState", d => { if (d?.resumeState?.active) updateBtn(d.resumeState); });
    return;
  }

  // Retry with increasing delays
  const delays = [300, 600, 1000, 1500, 2000, 3000, 4000, 5000];
  let i = 0;
  function retry() {
    const ex = document.getElementById("ar-btn");
    if (ex && ex.isConnected) return; // already injected
    if (ex && !ex.isConnected) ex.remove();
    if (tryInsert()) {
      safeGet("resumeState", d => { if (d?.resumeState?.active) updateBtn(d.resumeState); });
      return;
    }
    i++;
    if (i < delays.length) setTimeout(retry, delays[i]);
    else {
      // Final fallback: floating action button (FAB) in the bottom-right corner
      // Guaranteed to be visible, clickable, and look premium!
      btn.className = "ar-fab";
      btn.style.cssText = `
        position: fixed !important;
        bottom: 24px !important;
        right: 24px !important;
        width: 44px !important;
        height: 44px !important;
        border-radius: 50% !important;
        background: #7c3aed !important;
        border: 1px solid rgba(255, 255, 255, 0.1) !important;
        color: #ffffff !important;
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        z-index: 2147483646 !important;
        box-shadow: 0 4px 16px rgba(124, 58, 237, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.2) !important;
        cursor: pointer !important;
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1) !important;
      `;
      document.body.appendChild(btn);
      safeGet("resumeState", d => { if (d?.resumeState?.active) updateBtn(d.resumeState); });
    }
  }
  setTimeout(retry, delays[0]);
}

// ── Panel ─────────────────────────────────────────────────────────────
let panelOpen = false;
let pollInterval = null;

function togglePanel() { panelOpen ? closePanel() : openPanel(); }

function openPanel() {
  if (document.getElementById("ar-panel")) return;
  panelOpen = true;

  const resetInfo = getResetInfo();
  // Position panel under the button
  const arBtn = document.getElementById("ar-btn");
  const btnRect = arBtn ? arBtn.getBoundingClientRect() : null;
  const panelRight = btnRect ? (window.innerWidth - btnRect.right - 4) : 8;
  const panelTop   = btnRect ? (btnRect.bottom + 6) : 48;

  const p = document.createElement("div");
  p.id = "ar-panel";
  p.style.right = panelRight + "px";
  p.style.top   = panelTop  + "px";
  p.innerHTML = `
    <div class="ar-hd">
      <div class="ar-hd-l">
        <div class="ar-ico">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/>
          </svg>
        </div>
        <div>
          <div class="ar-ttl">AutoResume</div>
          <div class="ar-sub">Auto-sends when your limit resets</div>
        </div>
      </div>
      <button class="ar-cls" id="ar-close">✕</button>
    </div>

    <div class="ar-tabs">
      <div class="ar-tab active" data-tab="setup">Setup</div>
      <div class="ar-tab" data-tab="status">Status</div>
      <div class="ar-tab" data-tab="log">Log</div>
    </div>

    <!-- SETUP TAB -->
    <div class="ar-tab-body active" id="ar-t-setup">
      <div>
        <label class="ar-lbl">Claude Chat URL</label>
        <div class="ar-url-r">
          <input id="ar-url" class="ar-inp" type="text"
            placeholder="https://claude.ai/chat/..." />
          <button class="ar-grab" id="ar-grab">Use current</button>
        </div>
      </div>
      <div>
        <label class="ar-lbl">Prompt Templates</label>
        <div class="ar-templates" id="ar-templates"></div>
      </div>
      <div>
        <label class="ar-lbl">Resume Prompt</label>
        <textarea id="ar-prompt" class="ar-txa"
          placeholder="Continue from where we left off. Next step: ..."></textarea>
        <div class="ar-prompt-stats">
          <span id="ar-prompt-char-count">0 chars</span> | <span id="ar-prompt-token-count" class="stat-highlight">0 tokens</span>
          &nbsp;·&nbsp;<button class="ar-tpl-save" id="ar-save-tpl">+ Save as template</button>
        </div>
      </div>
      <div class="ar-row2">
        <div>
          <label class="ar-lbl">Resets in (min)</label>
          <input id="ar-mins" class="ar-inp" type="number"
            value="${resetInfo?.mins ?? 0}" min="0" max="600"/>
          ${resetInfo
            ? `<div class="ar-auto">✓ Auto-detected: ${resetInfo.display} (${resetInfo.source})</div>`
            : `<div class="ar-auto" style="color:#4ade80;">✓ No active limit — Session: ${getUsageInfo().session?.pct ?? '?'}%</div>`}
        </div>
        <div>
          <label class="ar-lbl">Check every (s)</label>
          <input id="ar-interval" class="ar-inp" type="number" value="60" min="15" max="300"/>
          <div class="ar-hint">Retry interval</div>
        </div>
      </div>
      <div class="ar-div"></div>
      <div class="ar-settings-row">
        <span class="ar-settings-label">🔔 Sound notification</span>
        <input type="checkbox" class="ar-toggle" id="ar-sound-toggle" checked />
      </div>
      <div class="ar-settings-row">
        <span class="ar-settings-label">📊 Conversation stats</span>
        <input type="checkbox" class="ar-toggle" id="ar-stats-toggle" />
      </div>
      <div class="ar-settings-row">
        <span class="ar-settings-label">⌨ Shortcuts</span>
        <span><span class="ar-shortcut">Alt+Shift+R</span> panel · <span class="ar-shortcut">Alt+Shift+S</span> start/stop</span>
      </div>
      <div class="ar-div"></div>
      <button class="ar-btn-primary" id="ar-start">▶&nbsp; Start AutoResume</button>
      <button class="ar-btn-danger"  id="ar-stop" style="display:none">■&nbsp; Stop</button>
      <div class="ar-export-row">
        <button class="ar-btn-sm" id="ar-export">📤 Export Settings</button>
        <button class="ar-btn-sm" id="ar-import">📥 Import Settings</button>
      </div>
    </div>

    <!-- STATUS TAB -->
    <div class="ar-tab-body" id="ar-t-status">
      <div class="ar-sc" id="ar-sc">
        <div class="ar-sc-dot"></div>
        <div class="ar-sc-info">
          <div class="ar-sc-title" id="ar-sc-title">Idle</div>
          <div class="ar-sc-desc"  id="ar-sc-desc">Start from the Setup tab</div>
        </div>
      </div>
      <div class="ar-prog" id="ar-prog" style="display:none">
        <div class="ar-prog-bar"><div class="ar-prog-fill" id="ar-pf"></div></div>
        <div class="ar-prog-lbl" id="ar-pl"></div>
      </div>
      <div class="ar-task" id="ar-task">
        <div class="ar-task-row">
          <span class="ar-task-key">Status</span>
          <span class="ar-task-val muted" id="tk-status">—</span>
        </div>
        <div class="ar-task-row">
          <span class="ar-task-key">Session</span>
          <span class="ar-task-val muted" id="tk-session">—</span>
        </div>
        <div class="ar-task-row">
          <span class="ar-task-key">Weekly</span>
          <span class="ar-task-val muted" id="tk-weekly">—</span>
        </div>
        <div class="ar-task-row">
          <span class="ar-task-key">Prompt</span>
          <span class="ar-task-val muted" id="tk-prompt">—</span>
        </div>
        <div class="ar-task-row">
          <span class="ar-task-key">Chat</span>
          <span class="ar-task-val muted" id="tk-url">—</span>
        </div>
        <div class="ar-task-row">
          <span class="ar-task-key">Session Reset</span>
          <span class="ar-task-val muted" id="tk-time">—</span>
        </div>
        <div class="ar-task-row">
          <span class="ar-task-key">Attempts</span>
          <span class="ar-task-val muted" id="tk-attempts">0</span>
        </div>
      </div>
      <div class="ar-sparkline-wrap" id="ar-sparkline"></div>
      <button class="ar-btn-danger" id="ar-stop2" style="display:none">■&nbsp; Stop AutoResume</button>
    </div>

    <!-- LOG TAB -->
    <div class="ar-tab-body" id="ar-t-log">
      <div class="ar-log" id="ar-log">No log entries yet.</div>
    </div>
  `;

  document.body.appendChild(p);

  // ── Tab switching
  p.querySelectorAll(".ar-tab").forEach(tab => {
    tab.onclick = () => {
      p.querySelectorAll(".ar-tab").forEach(t => t.classList.remove("active"));
      p.querySelectorAll(".ar-tab-body").forEach(b => b.classList.remove("active"));
      tab.classList.add("active");
      p.querySelector(`#ar-t-${tab.dataset.tab}`).classList.add("active");
      if (tab.dataset.tab === "log") refreshLog();
      if (tab.dataset.tab === "status") { refreshStatus(); renderSparkline("ar-sparkline"); }
    };
  });

  // ── Update prompt stats
  const promptTa = p.querySelector("#ar-prompt");
  const charSpan = p.querySelector("#ar-prompt-char-count");
  const tokSpan  = p.querySelector("#ar-prompt-token-count");

  function updatePromptStats() {
    if (!promptTa || !charSpan || !tokSpan) return;
    const txt = promptTa.value || "";
    charSpan.textContent = `${txt.length} char${txt.length === 1 ? "" : "s"}`;
    const tokens = estimateTokens(txt);
    tokSpan.textContent = `${tokens} token${tokens === 1 ? "" : "s"}`;
  }

  if (promptTa) {
    promptTa.addEventListener("input", () => {
      updatePromptStats();
      // Auto-save draft
      const url = p.querySelector("#ar-url")?.value || "";
      autoSaveDraft(promptTa.value, url);
    });
  }

  // ── Prompt Templates
  function renderTemplates() {
    const container = p.querySelector("#ar-templates");
    if (!container) return;
    getTemplates(templates => {
      container.innerHTML = templates.map((t, i) => {
        if (t.custom) {
          return `<span class="ar-tpl-chip custom" data-idx="${i}" title="${escH(t.prompt)}" style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;">
            <span class="ar-tpl-text" style="pointer-events:none;">${escH(t.name)}</span>
            <span class="ar-tpl-del" data-idx="${i}" title="Delete template">✕</span>
          </span>`;
        } else {
          return `<button class="ar-tpl-chip" data-idx="${i}" title="${escH(t.prompt)}">${escH(t.name)}</button>`;
        }
      }).join("");

      container.querySelectorAll(".ar-tpl-chip, span.ar-tpl-chip").forEach(chip => {
        chip.onclick = (e) => {
          if (e.target.classList.contains("ar-tpl-del")) {
            e.stopPropagation();
            const idx = parseInt(e.target.dataset.idx);
            const customIdx = idx - BUILTIN_TEMPLATES.length;
            removeCustomTemplate(customIdx);
            showToast("✓ Template deleted");
            setTimeout(renderTemplates, 300);
            return;
          }
          const idx = parseInt(chip.dataset.idx);
          const tpl = templates[idx];
          if (tpl && promptTa) {
            promptTa.value = tpl.prompt;
            updatePromptStats();
            showToast(`✓ Template: ${tpl.name}`);
          }
        };
      });
    });
  }
  renderTemplates();

  // ── Save as template
  const saveTplBtn = p.querySelector("#ar-save-tpl");
  if (saveTplBtn) {
    saveTplBtn.onclick = () => {
      const text = promptTa?.value?.trim();
      if (!text) { showToast("⚠ Enter a prompt first"); return; }
      const name = text.slice(0, 20).replace(/[^a-zA-Z0-9 ]/g, "") + (text.length > 20 ? "…" : "");
      saveCustomTemplate(name, text);
      showToast("✓ Saved as template");
      setTimeout(renderTemplates, 300);
    };
  }

  // ── Sound toggle
  const soundToggle = p.querySelector("#ar-sound-toggle");
  if (soundToggle) {
    safeGet("soundEnabled", d => { soundToggle.checked = d?.soundEnabled !== false; });
    soundToggle.onchange = () => {
      safeSet({ soundEnabled: soundToggle.checked });
      safeSend({ type: "SET_SOUND_PREF", data: { enabled: soundToggle.checked } });
      if (soundToggle.checked) playNotificationChime();
    };
  }

  // ── Conversation stats toggle
  const statsToggle = p.querySelector("#ar-stats-toggle");
  if (statsToggle) {
    safeGet("convStatsVisible", d => {
      statsToggle.checked = !!d?.convStatsVisible;
      if (d?.convStatsVisible && location.href.includes("/chat/")) showConvStats();
    });
    statsToggle.onchange = () => {
      if (statsToggle.checked) showConvStats();
      else hideConvStats();
    };
  }

  // ── Export/Import
  const exportBtn = p.querySelector("#ar-export");
  const importBtn = p.querySelector("#ar-import");
  if (exportBtn) exportBtn.onclick = exportSettings;
  if (importBtn) importBtn.onclick = importSettings;

  // ── Close
  p.querySelector("#ar-close").onclick = closePanel;
  setTimeout(() => document.addEventListener("click", outsideClickH), 200);

  // ── Grab current URL
  p.querySelector("#ar-grab").onclick = () => {
    p.querySelector("#ar-url").value = location.href;
    showToast("✓ Current chat URL set");
  };

  // ── Start
  p.querySelector("#ar-start").onclick = () => {
    const url      = p.querySelector("#ar-url").value.trim();
    const prompt   = p.querySelector("#ar-prompt").value.trim();
    const mins     = parseInt(p.querySelector("#ar-mins").value) || 0;
    const interval = parseInt(p.querySelector("#ar-interval").value) || 60;

    if (!url.startsWith("https://claude.ai/chat/")) {
      showToast("⚠ Enter a valid Claude chat URL"); return;
    }
    if (!prompt) { showToast("⚠ Enter a resume prompt"); return; }

    safeSet({ savedSettings: { chatUrl: url, prompt, resetMinutes: mins, checkInterval: interval } });
    safeSend({ type: "START_RESUME", data: { chatUrl: url, prompt, resetMinutes: mins, checkInterval: interval } }, () => {
      showToast("✓ AutoResume started!");
      refreshStatus();
      // Switch to status tab
      p.querySelector('[data-tab="status"]').click();
    });
  };

  // ── Stop buttons
  [p.querySelector("#ar-stop"), p.querySelector("#ar-stop2")].forEach(btn => {
    if (btn) btn.onclick = () => {
      safeSend({ type: "STOP_RESUME" }, () => { showToast("Stopped"); refreshStatus(); });
    };
  });

  // ── Load saved settings
  safeGet(["savedSettings", "resumeState"], d => {
    const sv = d.savedSettings;
    const st = d.resumeState;
    if (sv) {
      if (sv.chatUrl) p.querySelector("#ar-url").value = sv.chatUrl;
      if (sv.prompt)  {
        p.querySelector("#ar-prompt").value = sv.prompt;
        updatePromptStats();
      }
      if (sv.checkInterval) p.querySelector("#ar-interval").value = sv.checkInterval;
      if (!resetInfo && sv.resetMinutes) p.querySelector("#ar-mins").value = sv.resetMinutes;
    }
    if (!p.querySelector("#ar-url").value && location.href.includes("/chat/"))
      p.querySelector("#ar-url").value = location.href;
    if (st) renderUI(st);
  });

  // ── Poll every 4s to refresh status + log
  if (pollInterval) clearInterval(pollInterval);
  let pollCount = 0;
  pollInterval = setInterval(() => {
    if (!isCtxValid() || !document.getElementById("ar-panel")) {
      clearInterval(pollInterval); pollInterval = null; return;
    }
    const activeTab = p.querySelector(".ar-tab.active")?.dataset?.tab;
    if (activeTab === "status") { refreshStatus(); renderSparkline("ar-sparkline"); }
    if (activeTab === "log")    refreshLog();
    // Refresh auto-detect
    const ri = getResetInfo();
    if (ri && p.querySelector("#ar-start").style.display !== "none") {
      p.querySelector("#ar-mins").value = ri.mins;
    }
    // Record usage snapshot every ~30s (every 7-8 polls)
    pollCount++;
    if (pollCount % 8 === 0) recordUsageSnapshot();
  }, 4000);
}

function closePanel() {
  document.getElementById("ar-panel")?.remove();
  document.removeEventListener("click", outsideClickH);
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
  panelOpen = false;
}
function outsideClickH(e) {
  const pan = document.getElementById("ar-panel");
  const btn = document.getElementById("ar-btn");
  if (pan && !pan.contains(e.target) && !btn?.contains(e.target)) closePanel();
}

// ── Refresh status tab ────────────────────────────────────────────────
function refreshStatus() {
  safeGet("resumeState", d => {
    if (d?.resumeState) renderUI(d.resumeState);
  });
}

function refreshLog() {
  safeGet("resumeState", d => {
    const el = document.getElementById("ar-log");
    if (!el) return;
    const log = d?.resumeState?.log;
    if (!log || log.length === 0) { el.textContent = "No log entries yet."; return; }
    el.innerHTML = log.map(line => {
      let cls = "";
      if (line.includes("✓") || line.includes("sent"))   cls = "ok";
      else if (line.includes("Wait") || line.includes("⚠")) cls = "warn";
      else if (line.includes("Check") || line.includes("#")) cls = "info";
      else if (line.includes("✗") || line.includes("fail") || line.includes("Error")) cls = "err";
      return `<span class="ar-log-line ${cls}">${escH(line)}</span>`;
    }).join("\n");
    el.scrollTop = el.scrollHeight;
  });
}

// ── Render UI from state ──────────────────────────────────────────────
function renderUI(state) {
  updateBtn(state);
  updateStatusTab(state);
  updateSetupBtns(state);
}

function updateBtn(state) {
  const btn = document.getElementById("ar-btn");
  if (!btn) return;
  const isFab = btn.classList.contains("ar-fab");
  btn.className = isFab ? "ar-fab" : "";
  if (!state?.active) return;
  const cls = { monitoring:"s-mon", waiting:"s-wait", checking:"s-chk",
                sending:"s-chk", done:"s-done" }[state.status] || "s-mon";
  btn.classList.add(cls);
}

function updateSetupBtns(state) {
  const p = document.getElementById("ar-panel");
  if (!p) return;
  const start  = p.querySelector("#ar-start");
  const stop   = p.querySelector("#ar-stop");
  if (!start || !stop) return;
  if (state?.active && state.status !== "done") {
    start.style.display = "none"; stop.style.display = "block";
  } else {
    start.style.display = "block"; stop.style.display = "none";
  }
}

function updateStatusTab(state) {
  const p = document.getElementById("ar-panel");
  if (!p) return;

  const sc   = p.querySelector("#ar-sc");
  const sct  = p.querySelector("#ar-sc-title");
  const scd  = p.querySelector("#ar-sc-desc");
  const prog = p.querySelector("#ar-prog");
  const pf   = p.querySelector("#ar-pf");
  const pl   = p.querySelector("#ar-pl");
  const stop2 = p.querySelector("#ar-stop2");

  if (!sc || !state) return;

  const clsMap = { monitoring:"s-mon", waiting:"s-wait", checking:"s-chk",
                   sending:"s-chk", done:"s-done", failed:"s-fail" };
  sc.className = `ar-sc ${clsMap[state.status] || ""}`;

  const titles = { monitoring:"Monitoring", waiting:"Waiting for Reset",
                   checking:"Checking", sending:"Sending Prompt",
                   done:"Done!", stopped:"Stopped", failed:"Failed" };
  const descs = {
    monitoring: "Watching for usage limit banner automatically",
    waiting:    `Limit detected — sleeping ${state.resetMinutes ?? 0} min before checking`,
    checking:   "Testing if the limit has cleared...",
    sending:    "Typing and sending your resume prompt",
    done:       "Prompt was sent successfully! Check your chat.",
    stopped:    "AutoResume was stopped manually",
    failed:     "Something went wrong — check the Log tab",
  };

  if (sct) sct.textContent = titles[state.status] || state.status;
  if (scd) scd.textContent = descs[state.status]  || "";

  // Progress bar
  if (prog && pf && pl) {
    if (state.status === "waiting" && state.limitDetectedAt) {
      const elapsed = (Date.now() - state.limitDetectedAt) / 60000;
      const total   = state.resetMinutes ?? 0;
      const pct     = total > 0 ? Math.min(96, (elapsed / total) * 100) : 96;
      const rem     = Math.max(0, total - elapsed);
      prog.style.display = "block";
      pf.style.width = pct + "%";
      pl.textContent = `${Math.ceil(rem)} min until first retry`;
    } else if (state.status === "done") {
      prog.style.display = "block";
      pf.style.width = "100%";
      pl.textContent = "Complete!";
    } else {
      prog.style.display = "none";
    }
  }

  // Task summary
  const tk = {
    status:   p.querySelector("#tk-status"),
    session:  p.querySelector("#tk-session"),
    weekly:   p.querySelector("#tk-weekly"),
    prompt:   p.querySelector("#tk-prompt"),
    url:      p.querySelector("#tk-url"),
    time:     p.querySelector("#tk-time"),
    attempts: p.querySelector("#tk-attempts"),
  };
  const statusColor = { done:"green", waiting:"yellow", monitoring:"green",
                        checking:"muted", failed:"err" };
  if (tk.status) {
    tk.status.textContent = titles[state.status] || "—";
    tk.status.className = `ar-task-val ${statusColor[state.status] || "muted"}`;
  }
  if (tk.prompt)   tk.prompt.textContent   = state.prompt   ? (state.prompt.slice(0,28) + (state.prompt.length>28?"…":"")) : "—";
  if (tk.url)      tk.url.textContent      = state.chatUrl  ? ("…/" + state.chatUrl.split("/").pop().slice(0,12) + "…") : "—";
  if (tk.attempts) tk.attempts.textContent = state.attempts || "0";

  // Live usage info from Claude's UI
  const usage = getUsageInfo();

  if (tk.session) {
    if (usage.session) {
      const pct = usage.session.pct;
      const resetTxt = usage.session.reset ? ` · resets ${usage.session.reset.display}` : "";
      tk.session.textContent = `${pct}%${resetTxt}`;
      tk.session.className = pct >= 100 ? "ar-task-val err" : pct >= 80 ? "ar-task-val yellow" : "ar-task-val green";
    } else {
      tk.session.textContent = "—";
      tk.session.className = "ar-task-val muted";
    }
  }

  if (tk.weekly) {
    if (usage.weekly) {
      const pct = usage.weekly.pct;
      const resetTxt = usage.weekly.reset ? ` · resets ${usage.weekly.reset.display}` : "";
      tk.weekly.textContent = `${pct}%${resetTxt}`;
      tk.weekly.className = pct >= 80 ? "ar-task-val yellow" : "ar-task-val muted";
    } else {
      tk.weekly.textContent = "—";
      tk.weekly.className = "ar-task-val muted";
    }
  }

  // Session reset time (used for AutoResume countdown)
  const ri = getResetInfo();
  if (tk.time) {
    if (ri) {
      tk.time.textContent  = `${ri.display} (${ri.source})`;
      tk.time.className    = "ar-task-val yellow";
    } else if (state.status === "done") {
      tk.time.textContent = "Reset!";
      tk.time.className   = "ar-task-val green";
    } else {
      tk.time.textContent = "—";
      tk.time.className   = "ar-task-val muted";
    }
  }

  if (stop2) stop2.style.display = (state.active && state.status !== "done") ? "block" : "none";
}

// ── Toast ─────────────────────────────────────────────────────────────
function showToast(msg) {
  let t = document.getElementById("ar-toast");
  if (!t) { t = document.createElement("div"); t.id = "ar-toast"; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2200);
}

function escH(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

// ── Active Input Token Counter ────────────────────────────────────────
function updateInputTokenCounter() {
  const input = getInput();
  if (!input) {
    document.getElementById("ar-input-counter")?.remove();
    return;
  }
  const text = input.innerText || "";
  const cleanText = text.trim();
  if (!cleanText) {
    document.getElementById("ar-input-counter")?.remove();
    return;
  }
  
  let counter = document.getElementById("ar-input-counter");
  if (!counter) {
    counter = document.createElement("div");
    counter.id = "ar-input-counter";
    counter.className = "ar-input-counter";
    const container = input.parentElement;
    if (container) {
      container.style.position = container.style.position || "relative";
      container.appendChild(counter);
    }
  }
  
  const tokens = estimateTokens(text);
  counter.textContent = `${tokens} token${tokens === 1 ? "" : "s"}`;
  if (tokens > 0) {
    counter.classList.add("active");
  } else {
    counter.classList.remove("active");
  }
}

function getUsageBarAnchor() {
  const input = getInput();
  if (!input) return null;
  
  let anchor = input.parentElement;
  while (anchor && anchor !== document.body) {
    if (anchor.tagName === 'FORM') return anchor;
    if (anchor.classList.contains('bg-background') || 
        anchor.querySelector('button[aria-label="Send message"]') ||
        anchor.querySelector('button[data-testid="send-button"]')) {
      return anchor;
    }
    anchor = anchor.parentElement;
  }
  return input.parentElement;
}

function updateUsageBarOnPage() {
  if (!isCtxValid()) return;
  const anchor = getUsageBarAnchor();
  if (!anchor) {
    document.getElementById("ar-page-usage-bar")?.remove();
    return;
  }
  
  let bar = document.getElementById("ar-page-usage-bar");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "ar-page-usage-bar";
    bar.className = "ar-page-usage-bar";
    bar.innerHTML = `
      <div class="ar-pub-row">
        <div class="ar-pub-col">
          <div class="ar-pub-meta">
            <span class="ar-pub-label">Session:</span>
            <span class="ar-pub-pct" id="ar-pub-session-pct">—</span>
            <span class="ar-pub-reset" id="ar-pub-session-reset"></span>
          </div>
          <div class="ar-pub-progress-bg">
            <div class="ar-pub-progress-fill" id="ar-pub-session-fill" style="width: 0%"></div>
          </div>
        </div>
        <div class="ar-pub-col">
          <div class="ar-pub-meta">
            <span class="ar-pub-label">Weekly:</span>
            <span class="ar-pub-pct" id="ar-pub-weekly-pct">—</span>
            <span class="ar-pub-reset" id="ar-pub-weekly-reset"></span>
          </div>
          <div class="ar-pub-progress-bg">
            <div class="ar-pub-progress-fill" id="ar-pub-weekly-fill" style="width: 0%"></div>
          </div>
        </div>
      </div>
    `;
    anchor.parentNode.insertBefore(bar, anchor.nextSibling);
  }
  
  const info = getUsageInfo();
  
  const sessPct = document.getElementById("ar-pub-session-pct");
  const sessReset = document.getElementById("ar-pub-session-reset");
  const sessFill = document.getElementById("ar-pub-session-fill");
  
  const weekPct = document.getElementById("ar-pub-weekly-pct");
  const weekReset = document.getElementById("ar-pub-weekly-reset");
  const weekFill = document.getElementById("ar-pub-weekly-fill");
  
  if (sessPct && sessReset && sessFill) {
    if (info.session) {
      const pct = info.session.pct;
      sessPct.textContent = `${pct}%`;
      sessFill.style.width = `${pct}%`;
      sessFill.className = "ar-pub-progress-fill " + (pct >= 100 ? "ar-pub-fill-red" : pct >= 80 ? "ar-pub-fill-yellow" : "ar-pub-fill-green");
      if (info.session.reset) {
        sessReset.textContent = `· resets in ${info.session.reset.display}`;
      } else {
        sessReset.textContent = "";
      }
    } else {
      sessPct.textContent = "—";
      sessFill.style.width = "0%";
      sessReset.textContent = "";
    }
  }
  
  if (weekPct && weekReset && weekFill) {
    if (info.weekly) {
      const pct = info.weekly.pct;
      weekPct.textContent = `${pct}%`;
      weekFill.style.width = `${pct}%`;
      weekFill.className = "ar-pub-progress-fill " + (pct >= 100 ? "ar-pub-fill-red" : pct >= 80 ? "ar-pub-fill-yellow" : "ar-pub-fill-blue");
      if (info.weekly.reset) {
        weekReset.textContent = `· resets in ${info.weekly.reset.display}`;
      } else {
        weekReset.textContent = "";
      }
    } else {
      weekPct.textContent = "—";
      weekFill.style.width = "0%";
      weekReset.textContent = "";
    }
  }
}

// ── MutationObserver ──────────────────────────────────────────────────
let dbT = null;
const mutObs = new MutationObserver(() => {
  if (!isCtxValid()) { mutObs.disconnect(); selfDestruct(); return; }
  clearTimeout(dbT);
  dbT = setTimeout(() => {
    if (!isCtxValid()) { selfDestruct(); return; }
    if (isLimitActive()) {
      const ri = getResetInfo();
      safeSend({ type: "LIMIT_DETECTED", resetMinutes: ri ? ri.mins : 0 });
    }
  }, 900);

  // Attach input listener to Claude's input box
  const input = getInput();
  if (input && !input.dataset.arListenerAdded) {
    input.dataset.arListenerAdded = "true";
    input.addEventListener("input", updateInputTokenCounter);
    input.addEventListener("keyup", updateInputTokenCounter);
    updateInputTokenCounter();
  } else if (!input) {
    document.getElementById("ar-input-counter")?.remove();
  }

  // Update native usage bar
  updateUsageBarOnPage();
});
try { mutObs.observe(document.body, { childList: true, subtree: true }); } catch {}

// ── Boot ──────────────────────────────────────────────────────────────
function boot() {
  injectStyles();

  // Start periodic check for button presence to handle SPA navigations reliably
  clearInterval(btnCheckInterval);
  btnCheckInterval = setInterval(() => {
    if (!isCtxValid()) { clearInterval(btnCheckInterval); return; }
    if (!shouldShowBtn()) {
      document.getElementById("ar-btn")?.remove();
      closePanel();
    } else {
      const ex = document.getElementById("ar-btn");
      if (!ex || !ex.isConnected) {
        if (ex) ex.remove();
        injectBtn();
      } else if (ex.classList.contains("ar-fab")) {
        // It's currently in fallback FAB mode. Check if the header has loaded now!
        if (hasHeaderAnchor()) {
          ex.remove();
          injectBtn(); // Upgrade it to header injection!
        }
      }
    }
  }, 2000);

  // Periodic usage checks
  clearInterval(usageFetchInterval);
  runPeriodicUsageFetch();
  usageFetchInterval = setInterval(runPeriodicUsageFetch, 30000);

  if (shouldShowBtn()) {
    injectBtn();
  }
  safeGet("resumeState", d => { if (d?.resumeState?.active) updateBtn(d.resumeState); });
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
