#!/usr/bin/env bash
# Tear down the entire CockroachDB multi-region GKE deployment.
# Destroys K8s resources first, then infrastructure.
set -euo pipefail

GCP_PROJECT_ID="${GCP_PROJECT_ID:?GCP_PROJECT_ID must be set}"

echo "==> Tearing down CockroachDB multi-region GKE cluster"

# Step 1: Delete K8s resources (parallel)
echo "==> Deleting K8s resources..."
(
  kubectl --context east delete -f dist/east-k8s.yaml --ignore-not-found 2>/dev/null &
  kubectl --context central delete -f dist/central-k8s.yaml --ignore-not-found 2>/dev/null &
  kubectl --context west delete -f dist/west-k8s.yaml --ignore-not-found 2>/dev/null &
  wait
) || true

# Step 2: Delete PVCs (StatefulSet PVCs are not deleted automatically)
echo "==> Deleting PVCs..."
for ctx in east central west; do
  ns="crdb-${ctx}"
  kubectl --context "${ctx}" -n "${ns}" delete pvc --all --ignore-not-found 2>/dev/null || true
done

# Step 3: Delete regional infrastructure (parallel)
echo "==> Deleting regional infrastructure..."
(
  gcloud deployment-manager deployments delete crdb-east --quiet --project "${GCP_PROJECT_ID}" &
  gcloud deployment-manager deployments delete crdb-central --quiet --project "${GCP_PROJECT_ID}" &
  gcloud deployment-manager deployments delete crdb-west --quiet --project "${GCP_PROJECT_ID}" &
  wait
) || true

# Step 4: Delete shared infrastructure
echo "==> Deleting shared infrastructure..."
gcloud deployment-manager deployments delete crdb-shared --quiet --project "${GCP_PROJECT_ID}" || true

# Step 5: Clean up local certs
rm -rf certs/

echo ""
echo "  NOTE: If you set up DNS delegation at your registrar, the NS records"
echo "  now point to deleted zones. Remove them to avoid stale DNS."

echo "==> Teardown complete"
