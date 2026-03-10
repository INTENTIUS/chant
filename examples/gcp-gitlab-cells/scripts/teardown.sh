#!/usr/bin/env bash
set -euo pipefail

source .env

echo "=== Tearing down cells ==="
for VALUES_FILE in values-*.yaml; do
  CELL=$(basename "$VALUES_FILE" .yaml | sed 's/values-//')
  echo "Uninstalling gitlab-cell-${CELL}..."
  helm uninstall "gitlab-cell-${CELL}" -n "cell-${CELL}" --wait || true
done

echo "=== Deleting K8s resources ==="
kubectl delete -f k8s.yaml --ignore-not-found || true

echo "=== Deleting Config Connector resources (GCP infra) ==="
kubectl delete -f config.yaml --ignore-not-found || true
echo "Waiting for Config Connector to delete GCP resources..."
sleep 60
kubectl wait --for=delete sqlinstances --all --timeout=600s 2>/dev/null || true
kubectl wait --for=delete redisinstances --all --timeout=300s 2>/dev/null || true

echo "=== Optional: Delete GKE cluster ==="
read -p "Delete GKE cluster '${CLUSTER_NAME:-gitlab-cells}'? [y/N] " CONFIRM
if [ "$CONFIRM" = "y" ]; then
  gcloud container clusters delete "${CLUSTER_NAME:-gitlab-cells}" \
    --region "${GCP_REGION:-us-central1}" --project "$GCP_PROJECT_ID" --quiet
fi

echo "Teardown complete."
