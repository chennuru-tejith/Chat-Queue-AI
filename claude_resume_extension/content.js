// Claude AutoResume — Content Script
// Hardened against "Extension context invalidated" errors

// ── Context validity guard ────────────────────────────────────────────
// When the extension is reloaded/updated, all chrome.runtime calls in
// already-running content scripts throw "Extension context invalidated".
// This helper checks validity before every call and self-destructs
// the content script cleanly if the context is gone.

function isContextValid() {
  try {
    // Accessing chrome.runtime.id throws if context is invalidated
    return !!(chrome?.runtime?.id);
  } catch {
    return false;
  }
}

function safeSendMessage(msg, callback) {
  if (!isContextValid()) return;
  try {
    chrome.runtime.sendMessage(msg, callback);
  } catch (e) {
    if (e.message?.includes("Extension context invalidated")) {
      selfDestruct();
    }
  }
}

function safeStorageGet(key, callback) {
  if (!isContextValid()) return;
  try {
    chrome.storage.local.get(key, callback);
  } catch (e) {
    if (e.message?.includes("Extension context invalidated")) {
      selfDestruct();
    }
  }
}

// Clean up everything when context dies
function selfDestruct() {
  try { observer.disconnect(); } catch {}
  try {
    if (bannerInterval) { clearInterval(bannerInterval); bannerInterval = null; }
  } catch {}
  try {
    document.getElementById("ar-banner")?.remove();
    document.getElementById("ar-style")?.remove();
  } catch {}
}

// ── Message handler ───────────────────────────────────────────────────
try {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!isContextValid()) return;

    if (msg.type === "CHECK_LIMIT") {
      sendResponse({ limited: isLimitActive() });
      return;
    }
    if (msg.type === "CHECK_AND_SEND") {
      checkAndSend(msg.prompt).then(sendResponse);
      return true; // keep channel open for async
    }
    if (msg.type === "INJECT_BANNER") {
      injectStatusBanner();
      sendResponse({ ok: true });
      return;
    }
  });
} catch (e) {
  // Context already invalid at script load — nothing to do
}

// ── Limit detection ───────────────────────────────────────────────────
function isLimitActive() {
  const body = document.body?.innerText?.toLowerCase() || "";
  const phrases = [
    "usage limit", "resets in", "try again in",
    "out of messages", "limit reached", "rate limit",
    "over the limit", "you've hit", "you've reached"
  ];
  if (phrases.some(p => body.includes(p))) return true;
  const input = getInputBox();
  if (input && input.getAttribute("contenteditable") === "false") return true;
  return false;
}

function canSend() {
  const input = getInputBox();
  return input !== null && input.getAttribute("contenteditable") !== "false";
}

function getInputBox() {
  return (
    document.querySelector('div[contenteditable="true"][data-placeholder]') ||
    document.querySelector("div.ProseMirror[contenteditable='true']")       ||
    document.querySelector('div[contenteditable="true"]')
  );
}

// ── Send ──────────────────────────────────────────────────────────────
async function checkAndSend(prompt) {
  if (isLimitActive()) return { sent: false, stillLimited: true };
  if (!canSend())      return { sent: false, reason: "input not ready" };
  const result = await typeAndSend(prompt);
  return { sent: result.ok, reason: result.msg };
}

async function typeAndSend(prompt) {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const box = getInputBox();
  if (!box) return { ok: false, msg: "no input box" };

  box.focus();
  await wait(300);
  document.execCommand("selectAll", false, null);
  document.execCommand("delete", false, null);
  await wait(200);

  document.execCommand("insertText", false, prompt);
  await wait(700);

  // Fallback: clipboard paste if execCommand didn't insert
  const text = box.innerText || box.textContent || "";
  if (!text.trim()) {
    const dt = new DataTransfer();
    dt.setData("text/plain", prompt);
    box.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
    await wait(700);
  }

  if (!(box.innerText || box.textContent || "").trim()) {
    return { ok: false, msg: "text not inserted" };
  }

  await wait(300);

  // Find send button
  const btnSelectors = [
    'button[aria-label="Send message"]',
    'button[aria-label="Send Message"]',
    'button[data-testid="send-button"]',
    'button[aria-label*="Send" i]',
  ];
  let btn = null;
  for (const sel of btnSelectors) {
    const b = document.querySelector(sel);
    if (b && !b.disabled) { btn = b; break; }
  }
  if (!btn) {
    const area = box.closest("form")
              || box.closest('[class*="composer"]')
              || box.parentElement;
    if (area) {
      const btns = Array.from(area.querySelectorAll("button:not([disabled])"));
      btn = btns.find(b => b.querySelector("svg") && b.offsetParent !== null);
    }
  }
  if (btn && !btn.disabled) {
    btn.click();
    await wait(500);
    return { ok: true, msg: "sent via button" };
  }

  // Enter key fallback
  box.focus();
  ["keydown", "keypress", "keyup"].forEach(type =>
    box.dispatchEvent(new KeyboardEvent(type, {
      key: "Enter", code: "Enter", keyCode: 13,
      which: 13, bubbles: true, cancelable: true
    }))
  );
  await wait(500);
  return { ok: true, msg: "sent via Enter key" };
}

// ── Debounced MutationObserver ────────────────────────────────────────
let debounceTimer = null;
const observer = new MutationObserver(() => {
  if (!isContextValid()) {
    // Context died while observer was running — clean up
    observer.disconnect();
    selfDestruct();
    return;
  }
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    if (!isContextValid()) { selfDestruct(); return; }
    if (isLimitActive()) {
      safeSendMessage({ type: "LIMIT_DETECTED" });
    }
  }, 800);
});

try {
  observer.observe(document.body, { childList: true, subtree: true });
} catch {}

// ── Status banner ─────────────────────────────────────────────────────
let bannerInterval = null;

function injectStatusBanner() {
  if (document.getElementById("ar-banner")) return;

  const style = document.createElement("style");
  style.id = "ar-style";
  style.textContent = `
    #ar-banner {
      position: fixed; bottom: 24px; right: 24px; z-index: 99999;
      display: flex; align-items: center; gap: 8px;
      background: rgba(20,20,24,0.92);
      border: 1px solid rgba(255,255,255,0.08); border-radius: 100px;
      padding: 8px 14px 8px 10px;
      font-family: -apple-system, sans-serif; font-size: 12px; color: #e8e8e8;
      backdrop-filter: blur(12px); box-shadow: 0 4px 24px rgba(0,0,0,0.4);
      cursor: pointer; transition: opacity 0.2s; user-select: none;
    }
    #ar-banner:hover { opacity: 0.85; }
    #ar-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: #4ade80; box-shadow: 0 0 6px #4ade80;
      animation: ar-pulse 2s infinite; flex-shrink: 0;
    }
    #ar-dot.waiting  { background:#facc15; box-shadow:0 0 6px #facc15; }
    #ar-dot.checking { background:#60a5fa; box-shadow:0 0 6px #60a5fa; animation:ar-blink 0.6s infinite; }
    #ar-dot.done     { background:#4ade80; box-shadow:0 0 6px #4ade80; animation:none; }
    #ar-dot.stopped  { background:#6b7280; box-shadow:none; animation:none; }
    @keyframes ar-pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:0.5;transform:scale(0.8)} }
    @keyframes ar-blink { 0%,100%{opacity:1} 50%{opacity:0.2} }
  `;

  const banner = document.createElement("div");
  banner.id = "ar-banner";
  banner.innerHTML = `<div id="ar-dot"></div><span id="ar-text">AutoResume active</span>`;

  if (!document.getElementById("ar-style")) document.head.appendChild(style);
  document.body.appendChild(banner);

  banner.addEventListener("click", () => {
    safeSendMessage({ type: "OPEN_POPUP" });
  });

  if (bannerInterval) clearInterval(bannerInterval);
  bannerInterval = setInterval(() => {
    // Stop polling if context is gone
    if (!isContextValid()) {
      clearInterval(bannerInterval);
      bannerInterval = null;
      selfDestruct();
      return;
    }

    safeStorageGet("resumeState", (d) => {
      const s    = d?.resumeState;
      const dot  = document.getElementById("ar-dot");
      const text = document.getElementById("ar-text");
      const ban  = document.getElementById("ar-banner");

      if (!s?.active) {
        clearInterval(bannerInterval);
        bannerInterval = null;
        ban?.remove();
        document.getElementById("ar-style")?.remove();
        return;
      }
      if (!dot || !text) return;

      dot.className =
        s.status === "waiting"                             ? "waiting"  :
        s.status === "checking" || s.status === "sending" ? "checking" :
        s.status === "done"                                ? "done"     :
        s.status === "stopped"                             ? "stopped"  : "";

      const msgs = {
        monitoring: "Monitoring for limit...",
        waiting:    "Waiting for reset...",
        checking:   "Checking limit...",
        sending:    "Sending prompt...",
        done:       "✓ Prompt sent!",
        stopped:    "Stopped",
        failed:     "Failed — see popup"
      };
      text.textContent = msgs[s.status] || s.status;
    });
  }, 3000);
}

// Inject banner on page load if a session is already active
safeStorageGet("resumeState", (d) => {
  if (d?.resumeState?.active) injectStatusBanner();
});
