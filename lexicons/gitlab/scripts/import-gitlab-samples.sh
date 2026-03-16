#!/usr/bin/env bash
set -euo pipefail

# GitLab CI samples roundtrip test
# Clones repos with real .gitlab-ci.yml files and runs parse+generate on each.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
CACHE_DIR="$ROOT_DIR/.cache"
SAMPLES_DIR="$CACHE_DIR/gitlab-ci-samples"
HELPER="$SCRIPT_DIR/roundtrip-helper.ts"

SKIP_CLONE=false
VERBOSE=false
FILTER_MANIFEST=""
PASS_THRESHOLD=80

usage() {
  echo "Usage: $0 [--skip-clone] [--verbose] [--manifest NAME]"
  echo ""
  echo "  --skip-clone   Skip git clone if repos already exist"
  echo "  --verbose      Show per-pipeline pass/fail output"
  echo "  --manifest NAME  Only test pipelines matching NAME"
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-clone) SKIP_CLONE=true; shift ;;
    --verbose) VERBOSE=true; shift ;;
    --manifest) FILTER_MANIFEST="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "Unknown option: $1"; usage ;;
  esac
done

# Repos to clone for sample .gitlab-ci.yml files
REPOS=(
  "https://gitlab.com/gitlab-org/gitlab-runner.git"
  "https://gitlab.com/gitlab-org/cli.git"
  "https://gitlab.com/gitlab-org/gitlab-pages.git"
  "https://gitlab.com/gitlab-org/gitlab-shell.git"
)

# Clone sample repos
if [[ "$SKIP_CLONE" == "false" ]] || [[ ! -d "$SAMPLES_DIR" ]]; then
  echo "Cloning GitLab CI sample repos..."
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

# Exclusion patterns — files that aren't GitLab CI pipelines
EXCLUSIONS=(
  "docker-compose"
  ".github/"
  "node_modules/"
  "vendor/"
)

should_exclude() {
  local file="$1"
  for pattern in "${EXCLUSIONS[@]}"; do
    if [[ "$file" == *"$pattern"* ]]; then
      return 0
    fi
  done
  return 1
}

# Discover .gitlab-ci.yml files
MANIFEST_LIST=$(mktemp)
trap 'rm -f "$MANIFEST_LIST"' EXIT
find "$SAMPLES_DIR" -type f -name ".gitlab-ci.yml" | sort > "$MANIFEST_LIST"
# Also look for files included via `include:local`
find "$SAMPLES_DIR" -type f -name "*.gitlab-ci.yml" | sort >> "$MANIFEST_LIST"

total=0
pass=0
fail=0
skip=0

echo "Running roundtrip tests..."
echo ""

while IFS= read -r manifest; do
  rel="${manifest#$SAMPLES_DIR/}"

  # Apply filter
  if [[ -n "$FILTER_MANIFEST" ]] && [[ "$rel" != *"$FILTER_MANIFEST"* ]]; then
    continue
  fi

  # Check exclusions
  if should_exclude "$rel"; then
    ((skip++)) || true
    if [[ "$VERBOSE" == "true" ]]; then
      echo "SKIP: $rel"
    fi
    continue
  fi

  ((total++)) || true

  # Validate it looks like a GitLab CI file (must contain either script: or include: or stages:)
  if ! grep -qE '^\s*(script:|include:|stages:)' "$manifest" 2>/dev/null; then
    ((skip++)) || true
    ((total--)) || true
    if [[ "$VERBOSE" == "true" ]]; then
      echo "SKIP (not CI): $rel"
    fi
    continue
  fi

  export VERBOSE
  if bun run "$HELPER" "$manifest" 2>/dev/null; then
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
  echo "No pipelines found to test."
  exit 1
fi
