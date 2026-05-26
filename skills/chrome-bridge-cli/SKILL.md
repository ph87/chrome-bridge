---
name: chrome-bridge-cli
description: Send JavaScript and helper commands through the Chrome Bridge native host.
---

# Chrome Bridge CLI Skill

## What This Skill Does

This skill provides CLI and helper scripts to control browser tabs through Chrome Bridge.
It reads mode/endpoint/token from `~/.chrome-bridge/config.json` and sends `Authorization: Bearer <token>`.

## Config

Config file: `~/.chrome-bridge/config.json`

```json
{"mode":"http","hostPort":"127.0.0.1:3456","socketPath":"/Users/<user>/.chrome-bridge/bridge.sock","token":"<uuid>"}
```

- `mode` controls transport: `http` or `ipc`.
- `hostPort` is used in `http` mode.
- `socketPath` is used in `ipc` mode.
- `token` is attached on every request as `Authorization: Bearer <token>`.
- You can override endpoint/token with env vars `HOST_URL`, `HOST_SOCKET_PATH`, and `HOST_TOKEN`.

Bridge flow:

1. `scripts/chrome-bridge-cli.js` sends requests to the native host over HTTP or IPC.
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
- `scripts/network.js`
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

Capture network traffic:

```bash
./scripts/chrome-bridge-cli.js --capture-network --duration-ms 5000 --reload --target-url-pattern example.com
```

Include response bodies:

```bash
./scripts/chrome-bridge-cli.js --capture-network --duration-ms 5000 --reload --include-bodies --target-tab 123456
```

The capture command returns structured JSON with tab metadata and `entries[]` rows containing request URL, method, resource type, response status, headers, timing, and optional response body fields.

Helper scripts:

```bash
node scripts/open_url.js --url "https://www.google.com"
node scripts/list_tabs.js
node scripts/list_frames.js --target-url-pattern google.com
node scripts/close_tab.js --tab-id 123456
node scripts/screenshot.js --output /tmp/page.png
node scripts/network.js --duration-ms 5000 --reload --target-url-pattern example.com
node scripts/click.js --selector "button[type='submit']"
node scripts/input.js --selector "input[name='q']" --text "hello world"
```

Screenshot options:

```bash
node scripts/screenshot.js --format jpeg --quality 85
node scripts/screenshot.js --full-page
node scripts/screenshot.js --target-url-pattern jianzirumian.xyz --output /tmp/blog.png
node scripts/network.js --include-bodies --target-tab 123456
```

If you change extension files such as `background.js`, `sidepanel.js`, or `manifest.json`, reload the unpacked extension in `chrome://extensions` before testing new CLI commands.
