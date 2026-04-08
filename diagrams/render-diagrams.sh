#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIAGRAM_DIR="${ROOT_DIR}/diagrams"

if ! command -v dot >/dev/null 2>&1; then
  echo "Error: Graphviz 'dot' command not found." >&2
  echo "Install Graphviz, then rerun this script." >&2
  exit 1
fi

for file in "${DIAGRAM_DIR}/architecture.dot"; do
  [ -e "${file}" ] || continue
  base="$(basename "${file}" .dot)"
  dot -Gdpi=180 -Tpng "${file}" -o "${DIAGRAM_DIR}/${base}.png"
  echo "Rendered ${base}.dot -> ${base}.png"
done
