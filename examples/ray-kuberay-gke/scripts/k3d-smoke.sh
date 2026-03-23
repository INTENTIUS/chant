#!/usr/bin/env bash
# k3d-smoke.sh — local KubeRay lifecycle smoke test for ray-kuberay-gke.
#
# Validates without GCP, Filestore, GCS, or Workload Identity:
#   1. KubeRay operator deploys and becomes Available
#   2. RayCluster CR is accepted and reaches state=ready
#   3. Head + 1 CPU worker join the cluster
#   4. ray.cluster_resources() shows >= 2 CPUs available
#
# Prerequisites: k3d, kubectl, npm
# Runtime: ~3 minutes
#
# Run: just local-smoke
#      OR: bash scripts/k3d-smoke.sh
set -euo pipefail

CLUSTER="ray-kuberay-smoke"
NAMESPACE="ray-system"
KUBERAY_HELM_VERSION="1.3.2"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cleanup() {
  echo "=== Deleting k3d cluster ==="
  k3d cluster delete "$CLUSTER" 2>/dev/null || true
}
trap cleanup EXIT

cd "$ROOT_DIR"

# --- 1. Prerequisites ---
echo "=== Checking prerequisites ==="
for cmd in k3d kubectl npm; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: $cmd not found. Install it before running the smoke test."
    exit 1
  fi
done

# --- 2. Create k3d cluster ---
echo "=== Creating k3d cluster: $CLUSTER ==="
k3d cluster create "$CLUSTER" \
  --k3s-arg "--disable=traefik@server:*" \
  --k3s-arg "--disable=servicelb@server:*" \
  --k3s-arg "--kubelet-arg=pod-max-pids=4096@server:*" \
  --wait

# --- 3. Install KubeRay operator ---
echo "=== Installing KubeRay operator (helm $KUBERAY_HELM_VERSION) ==="
helm repo add kuberay https://ray-project.github.io/kuberay-helm/ 2>/dev/null || true
helm repo update
helm upgrade --install kuberay-operator kuberay/kuberay-operator \
  -n kuberay-operator --create-namespace --version "$KUBERAY_HELM_VERSION"
kubectl -n kuberay-operator wait deploy/kuberay-operator \
  --for=condition=Available --timeout=120s

# --- 4. Build k3d manifests ---
echo "=== Building k3d manifests ==="
npm run build:k3d

# --- 5. Apply manifests ---
echo "=== Applying k3d manifests ==="
kubectl apply -f k3d/k3d.yaml

# --- 6. Wait for RayCluster ready ---
echo "=== Waiting for RayCluster state=ready (up to 5 minutes) ==="
kubectl -n "$NAMESPACE" wait raycluster/ray \
  --for=jsonpath='{.status.state}'=ready --timeout=300s

echo "=== Pods ==="
kubectl -n "$NAMESPACE" get pods -l ray.io/cluster-name=ray

# --- 7. Verify cluster resources ---
echo "=== Verifying ray.cluster_resources() ==="
HEAD_POD=$(kubectl -n "$NAMESPACE" get pod -l ray.io/node-type=head -o name | head -1)
kubectl -n "$NAMESPACE" exec "$HEAD_POD" -- \
  python -c "
import ray
ray.init(address='auto')
r = ray.cluster_resources()
print('cluster_resources:', r)
cpus = r.get('CPU', 0)
assert cpus >= 2, f'Expected >= 2 CPUs (head + worker), got {cpus}'
print(f'OK: {cpus} CPUs available')
"

echo ""
echo "Smoke test PASSED."
