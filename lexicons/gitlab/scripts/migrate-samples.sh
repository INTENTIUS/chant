#!/usr/bin/env bash
set -uo pipefail

# GitHub Actions samples roundtrip test for `chant migrate`.
# Clones public GitHub repos and runs the migrator against every
# .github/workflows/*.yml file. Asserts a configurable pass-rate
# threshold (default 70% — GH Actions surface is broader than
# GitLab CI so a slightly lower bar than gitlab-samples.sh's 80%).
#
# Out of CI by design: mirrors lexicons/gitlab/scripts/import-gitlab-
# samples.sh (which also clones real repos and is not part of the
# main PR workflow). Run locally:
#   bash lexicons/gitlab/scripts/migrate-samples.sh --verbose

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
CACHE_DIR="$ROOT_DIR/.cache"
SAMPLES_DIR="$CACHE_DIR/github-workflow-samples"
HELPER="$SCRIPT_DIR/migrate-helper.ts"

SKIP_CLONE=false
VERBOSE=false
FILTER_MANIFEST=""
PASS_THRESHOLD=70

usage() {
  echo "Usage: $0 [--skip-clone] [--verbose] [--manifest NAME] [--threshold N]"
  echo ""
  echo "  --skip-clone     Skip git clone if repos already exist"
  echo "  --verbose        Show per-workflow pass/fail output"
  echo "  --manifest NAME  Only test workflows matching NAME"
  echo "  --threshold N    Required pass-rate percentage (default 70)"
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-clone) SKIP_CLONE=true; shift ;;
    --verbose) VERBOSE=true; shift ;;
    --manifest) FILTER_MANIFEST="$2"; shift 2 ;;
    --threshold) PASS_THRESHOLD="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "Unknown option: $1"; usage ;;
  esac
done

# Public GitHub repos with diverse, real-world Actions workflows.
REPOS=(
  "https://github.com/actions/checkout.git"
  "https://github.com/actions/setup-node.git"
  "https://github.com/sveltejs/svelte.git"
  "https://github.com/vercel/next.js.git"
)

if [[ "$SKIP_CLONE" == "false" ]] || [[ ! -d "$SAMPLES_DIR" ]]; then
  echo "Cloning GitHub workflow sample repos..."
  mkdir -p "$SAMPLES_DIR"

  for repo in "${REPOS[@]}"; do
    name=$(basename "$repo" .git)
    dest="$SAMPLES_DIR/$name"
    if [[ -d "$dest" ]]; then
      rm -rf "$dest"
    fi
    echo "  Cloning $name..."
    git clone --depth 1 "$repo" "$dest" 2>/dev/null || {
      echo "  WARN: Failed to clone $name, skipping"
      continue
    }
  done
  echo "Clone complete."
else
  echo "Using cached repos at $SAMPLES_DIR"
fi

MANIFEST_LIST=$(mktemp)
trap 'rm -f "$MANIFEST_LIST"' EXIT
find "$SAMPLES_DIR" -type f -path '*/.github/workflows/*.yml' | sort > "$MANIFEST_LIST"
find "$SAMPLES_DIR" -type f -path '*/.github/workflows/*.yaml' | sort >> "$MANIFEST_LIST"

total=0
pass=0
fail=0
skip=0

echo "Running migration on $(wc -l < "$MANIFEST_LIST" | tr -d ' ') sample workflows..."
echo ""

while IFS= read -r manifest; do
  rel="${manifest#$SAMPLES_DIR/}"

  if [[ -n "$FILTER_MANIFEST" ]] && [[ "$rel" != *"$FILTER_MANIFEST"* ]]; then
    continue
  fi

  # Validate it looks like a GH Actions workflow (must contain jobs:)
  if ! grep -qE '^\s*jobs\s*:' "$manifest" 2>/dev/null; then
    ((skip++)) || true
    if [[ "$VERBOSE" == "true" ]]; then
      echo "SKIP (no jobs): $rel"
    fi
    continue
  fi

  ((total++)) || true

  export VERBOSE
  if npx tsx "$HELPER" "$manifest" 2>/dev/null; then
    ((pass++)) || true
    if [[ "$VERBOSE" == "true" ]]; then
      echo "PASS: $rel"
    fi
  else
    ((fail++)) || true
    if [[ "$VERBOSE" == "true" ]]; then
      echo "FAIL: $rel"
    fi
  fi
done < "$MANIFEST_LIST"

echo ""
echo "=== Results ==="
echo "Total:   $total"
echo "Pass:    $pass"
echo "Fail:    $fail"
echo "Skipped: $skip"

if [[ $total -gt 0 ]]; then
  rate=$(( (pass * 100) / total ))
  echo "Pass rate: ${rate}%"
  echo ""

  if [[ $rate -ge $PASS_THRESHOLD ]]; then
    echo "PASSED: ${rate}% >= ${PASS_THRESHOLD}% threshold"
    exit 0
  else
    echo "FAILED: ${rate}% < ${PASS_THRESHOLD}% threshold"
    exit 1
  fi
else
  echo "No workflows found to test."
  exit 1
fi
