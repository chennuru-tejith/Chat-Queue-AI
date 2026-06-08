<p align="center">
  <img src="assets/banner.png" alt="Claude AutoResume Banner" width="100%">
</p>

<h1 align="center">Claude AutoResume</h1>

<p align="center">
  <strong>An elegant, local-first Chrome extension that automatically reloads your chat, tracks your rate limits, and sends your queued prompts the moment Claude is ready.</strong>
</p>

<p align="center">
  <a href="https://github.com/chennuru-tejith/Claude-Chat-Resume-Bot/blob/main/LICENSE"><img src="https://img.shields.io/github/license/chennuru-tejith/Claude-Chat-Resume-Bot?style=for-the-badge&color=7c3aed" alt="License"></a>
  <a href="https://github.com/chennuru-tejith/Claude-Chat-Resume-Bot/stargazers"><img src="https://img.shields.io/github/stars/chennuru-tejith/Claude-Chat-Resume-Bot?style=for-the-badge&color=10b981" alt="Stars"></a>
  <a href="https://github.com/chennuru-tejith/Claude-Chat-Resume-Bot/issues"><img src="https://img.shields.io/github/issues/chennuru-tejith/Claude-Chat-Resume-Bot?style=for-the-badge&color=3b82f6" alt="Issues"></a>
  <img src="https://img.shields.io/badge/Platform-Chrome%20%7C%20Edge%20%7C%20Brave-violet?style=for-the-badge" alt="Platforms">
</p>

---

## ⚡️ Key Features

*   🔄 **Smart Rate-Limit Auto-Resume**: Automatically monitors for usage banners, sleeps during limits, and types + sends your prompt the second Claude becomes available.
*   📊 **Native Composer Progress Bar**: Sleek Session (5h) and Weekly (7d) usage bars injected directly below Claude's input box.
*   🕒 **Absolute Reset Time Parsing**: Reads absolute limit times (e.g. `until 4:30 AM`) and calculates dynamic countdown timers automatically.
*   🔏 **Local-First & Private**: Direct browser-to-API communication using your active session. No telemetry, tracking, or external servers.
*   💡 **Prompt Template Library**: Instant-access preset chips ("Continue coding", "Debug error", etc.) + custom template save slot.
*   💬 **Live Conversation Stats**: View messages count and total estimated tokens inside a beautiful floating badge.
*   🔔 **Sound Chime & Desktop Notifications**: Soft harmonic arpeggios play and chrome notifications trigger when your prompt successfully sends.
*   ⌨️ **Quick Keyboard Shortcuts**: Toggle panel (`Alt+Shift+R`) and start/stop AutoResume (`Alt+Shift+S`) instantly.



## 🚀 Quick Start

### 1. Install locally (Developer Mode)
1.  Download or clone this repository to your local machine.
2.  Open Chrome (or Brave, Edge, Opera) and navigate to `chrome://extensions`.
3.  Toggle the **Developer mode** switch in the top-right corner.
4.  Click **Load unpacked** in the top-left and select the `claude_resume_extension` folder.

### 2. How to Use
1.  Open the Claude chat you want to automate.
2.  Click the violet **AutoResume** clock icon in Claude's top-right header (or the floating action button fallback).
3.  Configure your settings:
    *   **Chat URL**: Click **Use current** to lock in your active conversation.
    *   **Resume Prompt**: Write what Claude should receive when it wakes up (or click one of our preset chips).
    *   **Resets In**: Auto-detected from the page limit banner or utilization statistics!
4.  Click **▶ Start AutoResume**.
5.  Sit back! You can safely focus on other tabs, and the extension will automatically type, submit, notification-chime, and refocus the chat when the limit resets.

---

## 🛠 Repository Structure

```text
claude_resume_extension/
  ├── manifest.json      # Extension metadata
  ├── background.js       # Background service worker (alarms, tabs, limits)
  ├── content.js          # In-page UI, limit checkers, API fetchers
  ├── icons/              # Extension logo icons
  └── popup/              # Toolbar popup UI (html, js, css)
```

---

## 🤝 Contributing

Contributions, issues, and feature requests are welcome! Feel free to check the [issues page](https://github.com/chennuru-tejith/Claude-Chat-Resume-Bot/issues).

If you find this project helpful, please give it a ⭐️ on GitHub! It helps more developers discover the tool.

## 📄 License

This project is licensed under the [MIT License](LICENSE).
