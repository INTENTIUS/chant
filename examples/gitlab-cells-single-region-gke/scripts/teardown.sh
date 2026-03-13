#!/usr/bin/env bash
set -euo pipefail

source .env

CELLS="${CELLS:-alpha beta}"

echo "=== Uninstalling Helm releases ==="
for CELL in $CELLS; do
  echo "Uninstalling gitlab-cell-${CELL}..."
  helm uninstall "gitlab-cell-${CELL}" -n "cell-${CELL}" --wait --ignore-not-found || true
done

echo "=== Cleaning up PVCs per cell ==="
for CELL in $CELLS; do
  kubectl -n "cell-${CELL}" delete pvc --all --ignore-not-found || true
done

echo "=== Uninstalling ESO and cert-manager ==="
helm uninstall external-secrets -n kube-system --ignore-not-found || true
helm uninstall cert-manager -n cert-manager --ignore-not-found || true

echo "=== Deleting K8s resources ==="
kubectl delete -f k8s.yaml --ignore-not-found || true

echo "=== Deleting Config Connector resources (GCP infra) ==="
kubectl delete -f config.yaml --ignore-not-found || true
echo "Waiting for Config Connector to delete GCP resources..."
sleep 60
kubectl wait --for=delete sqlinstances --all --timeout=600s 2>/dev/null || true
kubectl wait --for=delete redisinstances --all --timeout=300s 2>/dev/null || true

echo "=== Cleaning up Secret Manager secrets ==="
for CELL in $CELLS; do
  for KEY in db-password redis-password redis-cache-password root-password rails-secret; do
    gcloud secrets delete "gitlab-${CELL}-${KEY}" --project "$GCP_PROJECT_ID" --quiet || true
  done
done
gcloud secrets delete gitlab-smtp-password --project "$GCP_PROJECT_ID" --quiet || true

echo "=== Cleaning up IAM service accounts ==="
for SA in gitlab-eso gitlab-cert-manager config-connector; do
  gcloud iam service-accounts delete "${SA}@${GCP_PROJECT_ID}.iam.gserviceaccount.com" \
    --project "$GCP_PROJECT_ID" --quiet || true
done

echo "=== Optional: Delete GKE cluster ==="
read -r -p "Delete GKE cluster '${CLUSTER_NAME:-gitlab-cells}'? [y/N] " CONFIRM
if [ "$CONFIRM" = "y" ]; then
  gcloud container clusters delete "${CLUSTER_NAME:-gitlab-cells}" \
    --region "${GCP_REGION:-us-central1}" --project "$GCP_PROJECT_ID" --quiet
fi

echo "Teardown complete."
