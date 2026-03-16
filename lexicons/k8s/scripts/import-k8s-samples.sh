#!/usr/bin/env bash
set -euo pipefail

# Kubernetes examples roundtrip test
# Clones kubernetes/examples and runs parse+generate on each manifest.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
CACHE_DIR="$ROOT_DIR/.cache"
REPO_DIR="$CACHE_DIR/kubernetes-examples"
HELPER="$SCRIPT_DIR/roundtrip-helper.ts"

SKIP_CLONE=false
VERBOSE=false
FILTER_MANIFEST=""
PASS_THRESHOLD=95

usage() {
  echo "Usage: $0 [--skip-clone] [--verbose] [--manifest NAME]"
  echo ""
  echo "  --skip-clone   Skip git clone if repo already exists"
  echo "  --verbose      Show per-manifest pass/fail output"
  echo "  --manifest NAME  Only test manifests matching NAME"
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

# Clone or update the repo
if [[ "$SKIP_CLONE" == "false" ]] || [[ ! -d "$REPO_DIR" ]]; then
  echo "Cloning kubernetes/examples..."
  mkdir -p "$CACHE_DIR"
  if [[ -d "$REPO_DIR" ]]; then
    rm -rf "$REPO_DIR"
  fi
  git clone --depth 1 https://github.com/kubernetes/examples.git "$REPO_DIR" 2>/dev/null
  echo "Clone complete."
else
  echo "Using cached repo at $REPO_DIR"
fi

# Exclusion patterns — files/paths that aren't K8s manifests
EXCLUSIONS=(
  "kustomization.yaml"
  "kustomization.yml"
  "kustomize/"
  "Kustomization"
  "Chart.yaml"
  "values.yaml"
  "values.yml"
  "requirements.yaml"
  "helmfile.yaml"
  "skaffold.yaml"
  ".github/"
  "Makefile"
  "Dockerfile"
  "configtx.yaml"
  "crypto-config.yaml"
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

# Specific manifests to ignore — known failures to be triaged
IGNORE_LIST=(
  "_archived/newrelic/newrelic-config.yaml"
)

should_ignore() {
  local rel="$1"
  if [[ ${#IGNORE_LIST[@]} -eq 0 ]]; then
    return 1
  fi
  for entry in "${IGNORE_LIST[@]}"; do
    if [[ "$rel" == "$entry" ]]; then
      return 0
    fi
  done
  return 1
}

# Discover manifests (YAML only, no JSON)
MANIFEST_LIST=$(mktemp)
trap 'rm -f "$MANIFEST_LIST"' EXIT
find "$REPO_DIR" -type f \( -name "*.yaml" -o -name "*.yml" \) | sort > "$MANIFEST_LIST"

total=0
pass=0
fail=0
skip=0

echo "Running roundtrip tests..."
echo ""

while IFS= read -r manifest; do
  rel="${manifest#$REPO_DIR/}"

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

  # Check ignore list
  if should_ignore "$rel"; then
    ((skip++)) || true
    if [[ "$VERBOSE" == "true" ]]; then
      echo "SKIP (ignored): $rel"
    fi
    continue
  fi

  ((total++)) || true

  # Validate it's a K8s manifest (must contain both apiVersion: and kind:)
  if ! grep -q 'apiVersion:' "$manifest" 2>/dev/null || ! grep -q 'kind:' "$manifest" 2>/dev/null; then
    ((skip++)) || true
    ((total--)) || true
    if [[ "$VERBOSE" == "true" ]]; then
      echo "SKIP (not K8s): $rel"
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
  echo "No manifests found to test."
  exit 1
fi
