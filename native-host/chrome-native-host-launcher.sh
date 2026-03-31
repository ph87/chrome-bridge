#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_PATH="${SCRIPT_DIR}/app.js"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export CHROME_BRIDGE_PROJECT_ROOT="${PROJECT_ROOT}"
export CODEX_ACP_COMMAND="/opt/homebrew/bin/codex-acp"
export CODEX_ACP_ARGS_JSON='[]'
export CODEX_ACP_ADAPTER="acp-rpc"
export CODEX_ACP_MODE="acp_rpc"

exec /usr/bin/env node "${APP_PATH}"
