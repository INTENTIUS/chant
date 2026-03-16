#!/usr/bin/env bash
set -euo pipefail

# k3d validation: full roundtrip + kubectl apply on a real k3d cluster.
# Validates that Chant-serialized YAML produces working K8s resources.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
CACHE_DIR="$ROOT_DIR/.cache"
REPO_DIR="$CACHE_DIR/kubernetes-examples"
HELPER="$SCRIPT_DIR/full-roundtrip-helper.ts"

CLUSTER_NAME="chant-k8s-test"
REUSE_CLUSTER=false
KEEP_CLUSTER=false
VERBOSE=false

usage() {
  echo "Usage: $0 [--reuse-cluster] [--keep-cluster] [--verbose]"
  echo ""
  echo "  --reuse-cluster  Reuse existing k3d cluster if it exists"
  echo "  --keep-cluster   Don't delete the cluster when done"
  echo "  --verbose        Show detailed output"
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --reuse-cluster) REUSE_CLUSTER=true; shift ;;
    --keep-cluster) KEEP_CLUSTER=true; shift ;;
    --verbose) VERBOSE=true; shift ;;
    -h|--help) usage ;;
    *) echo "Unknown option: $1"; usage ;;
  esac
done

# --- Prerequisite checks ---

for cmd in k3d kubectl; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: $cmd is not installed or not on PATH"
    exit 1
  fi
done

# Ensure kubernetes/examples is cloned
if [[ ! -d "$REPO_DIR" ]]; then
  echo "Cloning kubernetes/examples..."
  mkdir -p "$CACHE_DIR"
  git clone --depth 1 https://github.com/kubernetes/examples.git "$REPO_DIR" 2>/dev/null
  echo "Clone complete."
fi

# --- Safe manifest allowlist ---
# These manifests have no cloud volumes, no CRDs, no GPUs, and use available images.

ALLOWLIST=(
  "web/guestbook-go/redis-master-controller.yaml"
  "web/guestbook-go/redis-master-service.yaml"
  "web/guestbook-go/redis-replica-controller.yaml"
  "web/guestbook-go/redis-replica-service.yaml"
  "web/guestbook-go/guestbook-controller.yaml"
  "web/guestbook-go/guestbook-service.yaml"
  "web/guestbook/frontend-deployment.yaml"
  "web/guestbook/frontend-service.yaml"
  "web/guestbook/redis-master-deployment.yaml"
  "web/guestbook/redis-master-service.yaml"
  "web/guestbook/redis-replica-deployment.yaml"
  "web/guestbook/redis-replica-service.yaml"
  "databases/cassandra/cassandra-service.yaml"
  "AI/vllm-deployment/vllm-service.yaml"
)

# --- Cluster management ---

cluster_exists() {
  k3d cluster list -o json 2>/dev/null | grep -q "\"name\":\"$CLUSTER_NAME\"" 2>/dev/null
}

cleanup() {
  if [[ "$KEEP_CLUSTER" == "false" ]] && cluster_exists; then
    echo ""
    echo "Deleting k3d cluster '$CLUSTER_NAME'..."
    k3d cluster delete "$CLUSTER_NAME" 2>/dev/null || true
  fi
}
trap cleanup EXIT

if cluster_exists; then
  if [[ "$REUSE_CLUSTER" == "true" ]]; then
    echo "Reusing existing k3d cluster '$CLUSTER_NAME'"
  else
    echo "Deleting existing k3d cluster '$CLUSTER_NAME'..."
    k3d cluster delete "$CLUSTER_NAME" 2>/dev/null
    echo "Creating k3d cluster '$CLUSTER_NAME'..."
    k3d cluster create "$CLUSTER_NAME" --no-lb --wait 2>/dev/null
  fi
else
  echo "Creating k3d cluster '$CLUSTER_NAME'..."
  k3d cluster create "$CLUSTER_NAME" --no-lb --wait 2>/dev/null
fi

echo "Waiting for cluster to be ready..."
kubectl wait --for=condition=Ready nodes --all --timeout=60s 2>/dev/null

echo ""
echo "=== Running k3d validation ==="
echo ""

total=0
pass=0
fail=0

for rel in "${ALLOWLIST[@]}"; do
  manifest="$REPO_DIR/$rel"

  if [[ ! -f "$manifest" ]]; then
    echo "SKIP (not found): $rel"
    continue
  fi

  ((total++)) || true

  # Run full roundtrip, capturing serialized YAML
  YAML_OUTPUT=$(mktemp)
  export VERBOSE EMIT_YAML=1
  if ! bun run "$HELPER" "$manifest" > "$YAML_OUTPUT" 2>/dev/null; then
    ((fail++)) || true
    echo "FAIL (roundtrip): $rel"
    rm -f "$YAML_OUTPUT"
    continue
  fi

  # Verify we got YAML output
  if [[ ! -s "$YAML_OUTPUT" ]]; then
    ((fail++)) || true
    echo "FAIL (empty YAML): $rel"
    rm -f "$YAML_OUTPUT"
    continue
  fi

  if [[ "$VERBOSE" == "true" ]]; then
    echo "--- Serialized YAML for $rel ---"
    cat "$YAML_OUTPUT"
    echo "---"
  fi

  # Apply to cluster
  if ! kubectl apply -f "$YAML_OUTPUT" 2>/dev/null; then
    ((fail++)) || true
    echo "FAIL (kubectl apply): $rel"
    rm -f "$YAML_OUTPUT"
    continue
  fi

  # Extract kind and name from the YAML to verify the resource exists
  # Parse the first document's kind and metadata.name
  kind=$(grep -m1 '^kind:' "$YAML_OUTPUT" | awk '{print $2}' | tr -d '\r')
  name=$(grep -m1 '^\s*name:' "$YAML_OUTPUT" | awk '{print $2}' | tr -d '\r"'"'"'')

  if [[ -z "$kind" ]] || [[ -z "$name" ]]; then
    ((fail++)) || true
    echo "FAIL (can't extract kind/name): $rel"
    rm -f "$YAML_OUTPUT"
    continue
  fi

  # Verify resource exists
  if kubectl get "$kind" "$name" &>/dev/null; then
    ((pass++)) || true
    echo "PASS: $rel ($kind/$name)"
  else
    ((fail++)) || true
    echo "FAIL (kubectl get): $rel ($kind/$name)"
  fi

  rm -f "$YAML_OUTPUT"
done

echo ""
echo "=== k3d Validation Results ==="
echo "Total:  $total"
echo "Pass:   $pass"
echo "Fail:   $fail"

if [[ $total -gt 0 && $fail -eq 0 ]]; then
  echo ""
  echo "ALL PASSED"
  exit 0
elif [[ $total -eq 0 ]]; then
  echo ""
  echo "No manifests tested."
  exit 1
else
  echo ""
  echo "FAILURES: $fail/$total"
  exit 1
fi
