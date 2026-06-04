# Claude Chat Resume Bot

Claude Chat Resume Bot is a Chrome extension that waits for a Claude usage limit
to reset, reopens the exact chat you selected, and sends the resume prompt you
prepared in advance.

## What It Does

- Monitors a Claude chat for usage-limit messages.
- Waits for your configured reset window.
- Rechecks Claude at your configured interval.
- Sends your saved prompt when the chat is available again.
- Shows session status and recent logs in the extension popup.

## Repository Layout

```text
claude_resume_extension/
  manifest.json
  background.js
  content.js
  popup/
    popup.html
    popup.js
  icons/
    icon16.png
    icon48.png
    icon128.png

Claude_AutoResume_Extension.zip
```

The editable extension source is in `claude_resume_extension/`. The ZIP file is
kept as a packaged copy of the extension.

## Install Locally

1. Open Chrome or another Chromium-based browser.
2. Go to `chrome://extensions`.
3. Enable Developer mode.
4. Click Load unpacked.
5. Select the `claude_resume_extension/` folder.

## Use

1. Open the Claude chat you want to resume.
2. Open the extension popup.
3. Click Use current tab, or paste a Claude chat URL.
4. Enter the prompt Claude should receive after the limit resets.
5. Set the reset time and retry interval.
6. Click Start AutoResume.

## Permissions

The extension uses Chrome storage, alarms, tabs, scripting, and notifications. It
only requests host access for `https://claude.ai/*`.
