#!/usr/bin/env bash
# k3d-smoke.sh — local routing smoke test for cell-router + topology-service.
#
# Validates routing logic without GCP, GitLab chart, or Cloud SQL.
# Runtime: ~3 minutes.
#
# Prerequisites: k3d, kubectl, docker, npm, python3 (for yaml serialisation)
# Run: npm run test:local
#      OR: bash scripts/k3d-smoke.sh
#
# What it tests:
#   1. Session cookie  _gitlab_session=cell1_*  → routes to cell-alpha
#   2. Routable token  glrt-cell_2_*            → routes to cell-beta
#   3. Path fallback   /some-org/project        → topology service → alpha (default)
#   4. Health endpoint /healthz                 → 200 ok
set -euo pipefail

CLUSTER="gitlab-cells-smoke"
HOST_PORT=8080
NODE_PORT=30080
NGINX_HOST_PORT=8081
NGINX_NODE_PORT=30081
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cleanup() {
  echo "=== Deleting k3d cluster ==="
  k3d cluster delete "$CLUSTER" 2>/dev/null || true
}

# Always delete cluster on exit (success or failure) so we don't leave debris.
trap cleanup EXIT

cd "$ROOT_DIR"

# --- 1. Prerequisites ---
echo "=== Checking k3d prerequisites ==="
for cmd in k3d kubectl docker npm helm; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: $cmd not found. Install it before running the smoke test."
    exit 1
  fi
done

# --- 2. Build images ---
echo "=== Building cell-router image ==="
docker build -t cell-router:local cell-router/ --quiet

echo "=== Building topology-service image ==="
docker build -t topology-service:local topology-service/ --quiet

# --- 3. Create k3d cluster ---
echo "=== Creating k3d cluster: $CLUSTER ==="
# --no-lb: no software load balancer (NodePort used instead)
# --port: maps localhost:8080 → k3d server node port 30080
# --k3s-arg: disable traefik and servicelb (not needed for NodePort)
k3d cluster create "$CLUSTER" \
  --port "${HOST_PORT}:${NODE_PORT}@server:0" \
  --port "${NGINX_HOST_PORT}:${NGINX_NODE_PORT}@server:0" \
  --k3s-arg "--disable=traefik@server:*" \
  --k3s-arg "--disable=servicelb@server:*" \
  --wait

echo "=== Loading images into k3d cluster ==="
k3d image import cell-router:local topology-service:local -c "$CLUSTER"

# --- Install ingress-nginx via Helm (NodePort on 30081 → localhost:8081) ---
# This mirrors the production nginx-ingress deployment and lets validate.sh
# test wildcard Host-header routing (the *.domain vs *.cell.domain bug).
echo "=== Installing ingress-nginx ==="
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx --force-update > /dev/null
helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx --create-namespace \
  --set controller.service.type=NodePort \
  --set controller.service.nodePorts.http="${NGINX_NODE_PORT}" \
  --set controller.admissionWebhooks.enabled=false \
  --wait --timeout=120s

# --- 4. Create namespaces ---
echo "=== Creating namespaces ==="
# Derive cell names from config — no hardcoded alpha/beta.
CELL_NAMES=$(bun -e "import { cells } from './src/config.ts'; process.stdout.write(cells.map(c => c.name).join(' '))")
kubectl create namespace system --dry-run=client -o yaml | kubectl apply -f -
for CELL_NAME in $CELL_NAMES; do
  kubectl create namespace "cell-${CELL_NAME}" --dry-run=client -o yaml | kubectl apply -f -
done

# Label namespaces so cross-namespace selectors match (mirrors production labels).
kubectl label namespace system app.kubernetes.io/part-of=system --overwrite
for CELL_NAME in $CELL_NAMES; do
  kubectl label namespace "cell-${CELL_NAME}" "gitlab.example.com/cell=${CELL_NAME}" --overwrite
done

# Create the dummy DB password secret referenced by the topology-service Deployment.
# The topology service will fail to connect (no real DB) and fall back to returning
# "alpha" as the default cell for all org_slug lookups — exactly what we want.
kubectl -n system create secret generic topology-smoke-db-secret \
  --from-literal=password=smoke-test-unused \
  --dry-run=client -o yaml | kubectl apply -f -

# --- 5. Build and apply k3d manifests ---
echo "=== Building k3d manifests ==="
npm run build:k3d

echo "=== Applying k3d manifests ==="
kubectl apply -f k3d.yaml

# --- 6. Wait for pods ---
echo "=== Waiting for pods to be ready ==="
kubectl -n system rollout status deployment/topology-service --timeout=60s
kubectl -n system rollout status deployment/cell-router --timeout=60s
for CELL_NAME in $CELL_NAMES; do
  kubectl -n "cell-${CELL_NAME}" rollout status "deployment/mock-gitlab-${CELL_NAME}" --timeout=60s
done

# --- 7. Run validation ---
# k3d-validate.sh has its own readiness retry loop for the NodePort.
echo "=== Running routing validation ==="
bash scripts/k3d-validate.sh

echo ""
echo "Smoke test PASSED."
