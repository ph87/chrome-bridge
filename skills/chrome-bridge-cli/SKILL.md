---
name: chrome-bridge-cli
description: Send JavaScript and helper commands through the Chrome Bridge native host.
---

# Chrome Bridge CLI Skill

## What This Skill Does

This skill provides CLI and helper scripts to control browser tabs through Chrome Bridge.
It reads host/port/token from `~/.chrome-bridge/config.json` and sends `Authorization: Bearer <token>`.

## Config

Config file: `~/.chrome-bridge/config.json`

```json
{"host":"127.0.0.1","port":3456,"token":"<uuid>"}
```

- `host` and `port` define the HTTP endpoint used by CLI tools.
- `token` is attached on every request as `Authorization: Bearer <token>`.
- You can override endpoint/token with env vars `HOST_URL` and `HOST_TOKEN`.

Bridge flow:

1. `scripts/chrome-bridge-cli.js` sends HTTP requests to the native host (`127.0.0.1:3456`).
2. Native host forwards tasks over Chrome Native Messaging.
3. Extension executes JavaScript on target tabs and returns results.

## Package Structure

- `SKILL.md`
- `scripts/chrome-bridge-cli.js`
- `scripts/_bridge_client.js`
- `scripts/open_url.js`
- `scripts/list_tabs.js`
- `scripts/list_frames.js`
- `scripts/close_tab.js`
- `scripts/screenshot.js`
- `scripts/click.js`
- `scripts/input.js`
- `scripts/launch_chrome.sh`

## Usage

Run from the `chrome-bridge-cli` skill root.

Health:

```bash
./scripts/chrome-bridge-cli.js --health
```

Execute JavaScript on active tab:

```bash
./scripts/chrome-bridge-cli.js --code "document.title='EXEC_OK'"
```

Execute JavaScript on specific tab:

```bash
./scripts/chrome-bridge-cli.js --code "document.body.style.background='gold'" --target-tab 123456
```

Execute JavaScript by URL pattern:

```bash
./scripts/chrome-bridge-cli.js --code "document.title='DONE'" --target-url-pattern google.com
```

Execute JavaScript in an iframe by URL pattern:

```bash
./scripts/chrome-bridge-cli.js --code "document.body.style.outline='3px solid red'" --frame-url-pattern recaptcha
```

Open URL through JS:

```bash
./scripts/chrome-bridge-cli.js --open-url "https://www.google.com"
```

Close a tab by id:

```bash
./scripts/chrome-bridge-cli.js --close-tab 123456
```

Read host events:

```bash
./scripts/chrome-bridge-cli.js --events
```

Helper scripts:

```bash
node scripts/open_url.js --url "https://www.google.com"
node scripts/list_tabs.js
node scripts/list_frames.js --target-url-pattern google.com
node scripts/close_tab.js --tab-id 123456
node scripts/screenshot.js --output /tmp/page.png
node scripts/click.js --selector "button[type='submit']"
node scripts/input.js --selector "input[name='q']" --text "hello world"
```

Screenshot options:

```bash
node scripts/screenshot.js --format jpeg --quality 85
node scripts/screenshot.js --full-page
node scripts/screenshot.js --target-url-pattern jianzirumian.xyz --output /tmp/blog.png
```
