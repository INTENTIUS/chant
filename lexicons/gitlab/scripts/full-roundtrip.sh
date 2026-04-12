#!/usr/bin/env bash
set -euo pipefail

# Full roundtrip test for GitLab CI lexicon
# Runs parse → generate → import → serialize back → re-parse → compare
# on pipeline fixture files and optionally on real-world samples.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
HELPER="$SCRIPT_DIR/full-roundtrip-helper.ts"

VERBOSE=false
SKIP_SERIALIZE=false
FIXTURES_ONLY=true

usage() {
  echo "Usage: $0 [--verbose] [--skip-serialize] [--include-samples]"
  echo ""
  echo "  --verbose          Show per-pipeline pass/fail output"
  echo "  --skip-serialize   Skip Phase 3 (serialize-back comparison)"
  echo "  --include-samples  Also test real-world samples (requires prior import)"
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --verbose) VERBOSE=true; shift ;;
    --skip-serialize) SKIP_SERIALIZE=true; shift ;;
    --include-samples) FIXTURES_ONLY=false; shift ;;
    -h|--help) usage ;;
    *) echo "Unknown option: $1"; usage ;;
  esac
done

HELPER_ARGS=()
if [[ "$SKIP_SERIALIZE" == "true" ]]; then
  HELPER_ARGS+=("--skip-serialize")
fi

total=0
pass=0
fail=0

run_file() {
  local file="$1"
  local rel="${file#$ROOT_DIR/}"
  ((total++)) || true

  export VERBOSE
  if npx tsx "$HELPER" "${HELPER_ARGS[@]}" "$file" 2>/dev/null; then
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
}

# Run on pipeline fixtures
echo "Running full roundtrip on pipeline fixtures..."
for fixture in "$ROOT_DIR"/src/testdata/pipelines/*.yml; do
  if [[ -f "$fixture" ]]; then
    run_file "$fixture"
  fi
done

# Optionally run on real-world samples
if [[ "$FIXTURES_ONLY" == "false" ]]; then
  SAMPLES_DIR="$ROOT_DIR/../../.cache/gitlab-ci-samples"
  if [[ -d "$SAMPLES_DIR" ]]; then
    echo "Running full roundtrip on real-world samples..."
    while IFS= read -r manifest; do
      # Validate it looks like a GitLab CI file
      if grep -qE '^\s*(script:|include:|stages:)' "$manifest" 2>/dev/null; then
        run_file "$manifest"
      fi
    done < <(find "$SAMPLES_DIR" -type f -name ".gitlab-ci.yml" | sort)
  else
    echo "No samples found at $SAMPLES_DIR — run 'just import-samples' first"
  fi
fi

echo ""
echo "=== Full Roundtrip Results ==="
echo "Total:   $total"
echo "Pass:    $pass"
echo "Fail:    $fail"

if [[ $total -gt 0 ]]; then
  rate=$(( (pass * 100) / total ))
  echo "Pass rate: ${rate}%"
  if [[ $fail -eq 0 ]]; then
    echo "ALL PASSED"
    exit 0
  else
    echo "SOME FAILURES"
    exit 1
  fi
else
  echo "No pipeline files found to test."
  exit 1
fi
