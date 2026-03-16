#!/usr/bin/env bash
set -euo pipefail

example="${1:?Usage: ./run-example.sh <example-name> [prompt]}"
prompt="${2:-Build, lint, and test this example.}"

cd "$(dirname "$0")/$example"

claude -p "$prompt" \
  --allowedTools "Bash(bun run *)" "Bash(kubectl *)" "Bash(aws *)" "Read" "Glob" "Grep"
