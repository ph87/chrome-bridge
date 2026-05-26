---
name: chrome-bridge-setup
description: Install the Chrome extension and native host bridge for Chrome Bridge.
---

# Chrome Bridge Setup Skill

## What This Skill Does

This skill contains setup assets and installation steps for Chrome Bridge:

1. Load the extension from `chrome-bridge-extension/`.
2. Register the native messaging host from `native-host/`.
3. Install the manifest with `scripts/setup.sh`.
4. Create `~/.chrome-bridge/config.json` with mode/endpoint/token defaults.

## Config

Setup creates `~/.chrome-bridge/config.json`:

```json
{"mode":"http","hostPort":"127.0.0.1:3456","socketPath":"/Users/<user>/.chrome-bridge/bridge.sock","token":"<uuid>"}
```

- `mode` is selectable in extension side panel settings (`http` or `ipc`).
- `hostPort` is editable in `http` mode.
- `socketPath` is used in `ipc` mode.
- `token` is shown in side panel settings and can be rotated with `Refresh`.
- Any transport config/token change is written back to this file.

## Package Structure

- `SKILL.md`
- `chrome-bridge-extension/`
- `native-host/`
- `scripts/setup.sh`

## Install

Run from the `chrome-bridge-setup` skill root.

### 1) Load Extension in Chrome

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Use extension path:

```bash
echo "$(pwd)/chrome-bridge-extension"
```

4. Click `Load unpacked` and choose the printed path.
5. Copy the extension ID.

### 2) Register Native Messaging Host (macOS)

Run installer:

```bash
./scripts/setup.sh
```

Or pass extension ID directly:

```bash
./scripts/setup.sh <EXTENSION_ID>
```

After install, reload the extension in `chrome://extensions`.
