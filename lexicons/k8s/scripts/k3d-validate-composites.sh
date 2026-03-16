#!/usr/bin/env bash
set -euo pipefail

# k3d validation for composites: generate composite instances, serialize to YAML,
# apply to a k3d cluster, and verify resources exist.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER="$SCRIPT_DIR/k3d-composite-helper.ts"

CLUSTER_NAME="chant-k8s-composites"
REUSE_CLUSTER=false
KEEP_CLUSTER=false
VERBOSE=false
NS="composite-test"

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

for cmd in k3d kubectl bun; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: $cmd is not installed or not on PATH"
    exit 1
  fi
done

# --- Cluster management ---

cluster_exists() {
  k3d cluster list -o json 2>/dev/null | grep -q "\"name\":\"$CLUSTER_NAME\"" 2>/dev/null
}

cleanup() {
  # Clean up cluster-scoped resources
  if kubectl get clusterrole test-agent-role &>/dev/null 2>&1; then
    kubectl delete clusterrole test-agent-role --ignore-not-found 2>/dev/null || true
    kubectl delete clusterrolebinding test-agent-binding --ignore-not-found 2>/dev/null || true
  fi

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
echo "=== Generating composite YAML ==="
echo ""

YAML_OUTPUT=$(mktemp)
if ! bun run "$HELPER" > "$YAML_OUTPUT" 2>/dev/null; then
  echo "FAIL: k3d-composite-helper.ts failed to generate YAML"
  rm -f "$YAML_OUTPUT"
  exit 1
fi

if [[ ! -s "$YAML_OUTPUT" ]]; then
  echo "FAIL: helper produced empty YAML"
  rm -f "$YAML_OUTPUT"
  exit 1
fi

if [[ "$VERBOSE" == "true" ]]; then
  echo "--- Generated YAML ---"
  cat "$YAML_OUTPUT"
  echo "--- End YAML ---"
  echo ""
fi

echo "=== Applying composites to k3d ==="
echo ""

if ! kubectl apply -f "$YAML_OUTPUT"; then
  echo ""
  echo "FAIL: kubectl apply failed"
  rm -f "$YAML_OUTPUT"
  exit 1
fi

echo ""
echo "=== Verifying resources ==="
echo ""

pass=0
fail=0

check_resource() {
  local kind="$1"
  local name="$2"
  local ns="${3:-}"

  local ns_flag=""
  if [[ -n "$ns" ]]; then
    ns_flag="-n $ns"
  fi

  # shellcheck disable=SC2086
  if kubectl get "$kind" "$name" $ns_flag &>/dev/null; then
    ((pass++)) || true
    echo "PASS: $kind/$name${ns:+ (ns: $ns)}"
  else
    ((fail++)) || true
    echo "FAIL: $kind/$name${ns:+ (ns: $ns)}"
  fi
}

# NamespaceEnv resources
check_resource namespace "$NS"
check_resource resourcequota "${NS}-quota" "$NS"
check_resource limitrange "${NS}-limits" "$NS"
check_resource networkpolicy "${NS}-default-deny" "$NS"

# AutoscaledService resources
check_resource deployment autoscaled-svc "$NS"
check_resource service autoscaled-svc "$NS"
check_resource hpa autoscaled-svc "$NS"
check_resource pdb autoscaled-svc "$NS"

# WorkerPool resources
check_resource deployment test-worker "$NS"
check_resource serviceaccount test-worker-sa "$NS"
check_resource role test-worker-role "$NS"
check_resource rolebinding test-worker-binding "$NS"
check_resource configmap test-worker-config "$NS"

# NodeAgent resources
check_resource daemonset test-agent "$NS"
check_resource serviceaccount test-agent-sa "$NS"
check_resource clusterrole test-agent-role
check_resource clusterrolebinding test-agent-binding

echo ""
echo "=== Waiting for workload readiness ==="
echo ""

# AutoscaledService: wait for deployment pods
if kubectl -n "$NS" rollout status deployment/autoscaled-svc --timeout=90s 2>/dev/null; then
  echo "PASS: autoscaled-svc deployment rolled out"
  ((pass++)) || true
else
  echo "FAIL: autoscaled-svc deployment did not roll out"
  ((fail++)) || true
fi

# NodeAgent: wait for daemonset pods
if kubectl -n "$NS" rollout status daemonset/test-agent --timeout=90s 2>/dev/null; then
  echo "PASS: test-agent daemonset rolled out"
  ((pass++)) || true
else
  echo "FAIL: test-agent daemonset did not roll out"
  ((fail++)) || true
fi

total=$((pass + fail))

echo ""
echo "=== Composite Validation Results ==="
echo "Total:  $total"
echo "Pass:   $pass"
echo "Fail:   $fail"

rm -f "$YAML_OUTPUT"

if [[ $fail -eq 0 ]]; then
  echo ""
  echo "ALL PASSED"
  exit 0
else
  echo ""
  echo "FAILURES: $fail/$total"
  exit 1
fi
