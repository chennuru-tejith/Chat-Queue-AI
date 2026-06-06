// Claude AutoResume — Content Script v4
// Complete rewrite: correct header injection, reliable limit detection, task overview

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
  try { document.getElementById("ar-btn")?.remove(); } catch {}
  try { document.getElementById("ar-panel")?.remove(); } catch {}
  try { document.getElementById("ar-styles")?.remove(); } catch {}
  try { document.getElementById("ar-input-counter")?.remove(); } catch {}
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
  });
} catch {}

// ── Limit & input detection ───────────────────────────────────────────
function isLimitActive() {
  try {
    const body = document.body.innerText.toLowerCase();

    // Check for explicit limit phrases
    const limitPhrases = [
      "usage limit reached", "you've reached your limit",
      "try again in", "out of messages", "limit reached",
      "over the limit", "you've hit your"
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
function getResetInfo() {
  try {
    // First try reading from the actual session bar element (most reliable)
    const allText = Array.from(document.querySelectorAll("*"))
      .filter(el => el.childElementCount === 0 && el.textContent.includes("resets in"))
      .map(el => el.textContent);
    
    const text = allText.length > 0 ? allText.join(" ") : document.body.innerText;
    // Matches: "resets in 4h 34m", "resets in 2h", "resets in 47m", "resets in 3d 14h"
    const patterns = [
      /resets\s+in\s+(\d+)d\s+(\d+)h/i,   // Xd Xh
      /resets\s+in\s+(\d+)h\s+(\d+)m/i,   // Xh Xm
      /resets\s+in\s+(\d+)h/i,             // Xh only
      /resets\s+in\s+(\d+)m/i,             // Xm only
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
  } catch {}
  return null;
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
      border: 1px solid rgba(255, 255, 255, 0.05);
      background: rgba(255, 255, 255, 0.02);
      cursor: pointer;
      color: #9b9ba8;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      position: relative;
      flex-shrink: 0;
      transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
      vertical-align: middle;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
    }
    #ar-btn:hover {
      background: rgba(255, 255, 255, 0.06);
      border-color: rgba(167, 139, 250, 0.35);
      color: #f3f4f6;
      box-shadow: 0 0 10px rgba(167, 139, 250, 0.15);
      transform: translateY(-1px);
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
      color: #a78bfa;
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
    #ar-btn.s-mon  { color:#a78bfa; }
    #ar-btn.s-mon  #ar-badge { display:block; background:#4ade80; animation:ar-p 2s infinite; }
    #ar-btn.s-wait #ar-badge { display:block; background:#facc15; animation:ar-p 2s infinite; }
    #ar-btn.s-chk  #ar-badge { display:block; background:#60a5fa; animation:ar-p 0.7s infinite; }
    #ar-btn.s-done #ar-badge { display:block; background:#4ade80; }
    @keyframes ar-p { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:0.4;transform:scale(0.65)} }

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
  `;
  document.head.appendChild(el);
}

// ── Inject button into Claude header ─────────────────────────────────
function shouldShowBtn() {
  return window.location.href.includes("/chat/");
}

function injectBtn() {
  if (!shouldShowBtn()) {
    document.getElementById("ar-btn")?.remove();
    return;
  }
  if (document.getElementById("ar-btn")) return;

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
    // Claude's ghost icon has a specific SVG path we can target
    // It's an SVG with a ghost-like shape in the top-right corner
    // Strategy 1: find all buttons in the viewport top-right quadrant
    const allBtns = Array.from(document.querySelectorAll("button"));
    const vpW = window.innerWidth;

    // Filter to buttons in top bar (top 60px) and right half of screen
    const topRightBtns = allBtns.filter(b => {
      const r = b.getBoundingClientRect();
      return r.top < 60 && r.top >= 0 && r.left > vpW * 0.5 && r.width > 0 && r.height > 0;
    });

    if (topRightBtns.length === 0) return false;

    // Sort by left position (rightmost first)
    topRightBtns.sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left);

    // The ghost button is the rightmost one
    const ghostBtn = topRightBtns[0];
    if (!ghostBtn?.parentElement) return false;

    // Insert our button just before the ghost button
    ghostBtn.parentElement.insertBefore(btn, ghostBtn);
    return true;
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
    if (document.getElementById("ar-btn")) return; // already injected
    if (tryInsert()) {
      safeGet("resumeState", d => { if (d?.resumeState?.active) updateBtn(d.resumeState); });
      return;
    }
    i++;
    if (i < delays.length) setTimeout(retry, delays[i]);
    else {
      // Final fallback: fixed position
      btn.style.cssText = "position:fixed!important;top:8px;right:52px;z-index:2147483646;";
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
        <label class="ar-lbl">Resume Prompt</label>
        <textarea id="ar-prompt" class="ar-txa"
          placeholder="Continue from where we left off. Next step: ..."></textarea>
        <div class="ar-prompt-stats">
          <span id="ar-prompt-char-count">0 chars</span> | <span id="ar-prompt-token-count" class="stat-highlight">0 tokens</span>
        </div>
      </div>
      <div class="ar-row2">
        <div>
          <label class="ar-lbl">Resets in (min)</label>
          <input id="ar-mins" class="ar-inp" type="number"
            value="${resetInfo?.mins || 180}" min="1" max="600"/>
          ${resetInfo
            ? `<div class="ar-auto">✓ Auto-detected: ${resetInfo.display}</div>`
            : `<div class="ar-hint">Check the bar above ↑</div>`}
        </div>
        <div>
          <label class="ar-lbl">Check every (s)</label>
          <input id="ar-interval" class="ar-inp" type="number" value="60" min="15" max="300"/>
          <div class="ar-hint">Retry interval</div>
        </div>
      </div>
      <div class="ar-div"></div>
      <button class="ar-btn-primary" id="ar-start">▶&nbsp; Start AutoResume</button>
      <button class="ar-btn-danger"  id="ar-stop" style="display:none">■&nbsp; Stop</button>
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
          <span class="ar-task-key">Prompt</span>
          <span class="ar-task-val muted" id="tk-prompt">—</span>
        </div>
        <div class="ar-task-row">
          <span class="ar-task-key">Chat</span>
          <span class="ar-task-val muted" id="tk-url">—</span>
        </div>
        <div class="ar-task-row">
          <span class="ar-task-key">Resets in</span>
          <span class="ar-task-val muted" id="tk-time">—</span>
        </div>
        <div class="ar-task-row">
          <span class="ar-task-key">Attempts</span>
          <span class="ar-task-val muted" id="tk-attempts">0</span>
        </div>
      </div>
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
      if (tab.dataset.tab === "status") refreshStatus();
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
    promptTa.addEventListener("input", updatePromptStats);
  }

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
    const mins     = parseInt(p.querySelector("#ar-mins").value) || 180;
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
  pollInterval = setInterval(() => {
    if (!isCtxValid() || !document.getElementById("ar-panel")) {
      clearInterval(pollInterval); pollInterval = null; return;
    }
    const activeTab = p.querySelector(".ar-tab.active")?.dataset?.tab;
    if (activeTab === "status") refreshStatus();
    if (activeTab === "log")    refreshLog();
    // Refresh auto-detect
    const ri = getResetInfo();
    if (ri && p.querySelector("#ar-start").style.display !== "none") {
      p.querySelector("#ar-mins").value = ri.mins;
    }
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
  btn.className = "";
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
    waiting:    `Limit detected — sleeping ${state.resetMinutes || 180} min before checking`,
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
      const total   = state.resetMinutes || 180;
      const pct     = Math.min(96, (elapsed / total) * 100);
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
    prompt:   p.querySelector("#tk-prompt"),
    url:      p.querySelector("#tk-url"),
    time:     p.querySelector("#tk-time"),
    attempts: p.querySelector("#tk-attempts"),
  };
  const statusColor = { done:"green", waiting:"yellow", monitoring:"green",
                        checking:"info", failed:"err" };
  if (tk.status) {
    tk.status.textContent = titles[state.status] || "—";
    tk.status.className = `ar-task-val ${statusColor[state.status] || "muted"}`;
  }
  if (tk.prompt)   tk.prompt.textContent   = state.prompt   ? (state.prompt.slice(0,28) + (state.prompt.length>28?"…":"")) : "—";
  if (tk.url)      tk.url.textContent      = state.chatUrl  ? ("…/" + state.chatUrl.split("/").pop().slice(0,12) + "…") : "—";
  if (tk.attempts) tk.attempts.textContent = state.attempts || "0";

  // Auto-read reset time from page
  const ri = getResetInfo();
  if (tk.time) {
    if (ri) {
      tk.time.textContent  = ri.display;
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

// ── MutationObserver ──────────────────────────────────────────────────
let dbT = null, fbT = null;
const mutObs = new MutationObserver(() => {
  if (!isCtxValid()) { mutObs.disconnect(); selfDestruct(); return; }
  clearTimeout(dbT);
  dbT = setTimeout(() => {
    if (!isCtxValid()) { selfDestruct(); return; }
    if (isLimitActive()) safeSend({ type: "LIMIT_DETECTED" });
  }, 900);
  clearTimeout(fbT);
  fbT = setTimeout(() => {
    if (!shouldShowBtn()) {
      document.getElementById("ar-btn")?.remove();
      closePanel();
    } else if (!document.getElementById("ar-btn")) {
      injectBtn();
    }
  }, 1500);

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
});
try { mutObs.observe(document.body, { childList: true, subtree: true }); } catch {}

// ── Boot ──────────────────────────────────────────────────────────────
function boot() {
  injectStyles();
  if (shouldShowBtn()) {
    injectBtn();
  }
  safeGet("resumeState", d => { if (d?.resumeState?.active) updateBtn(d.resumeState); });
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
