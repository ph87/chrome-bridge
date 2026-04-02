#!/usr/bin/env bash
set -euo pipefail

# Simple host-health agent: echo each input line back to stdout.
while IFS= read -r line; do
  /bin/echo "${line}"
done
