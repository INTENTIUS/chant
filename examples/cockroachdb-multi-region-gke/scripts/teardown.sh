#!/usr/bin/env bash
# Tear down the entire CockroachDB multi-region GKE deployment.
# Destroys K8s resources first, then infrastructure via Config Connector,
# then the management cluster itself.
set -euo pipefail

GCP_PROJECT_ID="${GCP_PROJECT_ID:?GCP_PROJECT_ID must be set}"

echo "==> Tearing down CockroachDB multi-region GKE cluster"

# Step 0: Uninstall External Secrets Operator from workload clusters
echo "==> Uninstalling External Secrets Operator..."
for ctx in east central west; do
  helm uninstall external-secrets --kube-context "${ctx}" --namespace kube-system 2>/dev/null || true
done

# Step 1: Delete K8s resources from workload clusters (parallel)
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

# Step 3: Switch to management cluster and delete infra via Config Connector
echo "==> Switching to management cluster..."
gcloud container clusters get-credentials gke-crdb-mgmt --region us-central1 --project "${GCP_PROJECT_ID}"

echo "==> Deleting regional infrastructure via Config Connector..."
kubectl delete -f dist/east-infra.yaml --ignore-not-found 2>/dev/null || true
kubectl delete -f dist/central-infra.yaml --ignore-not-found 2>/dev/null || true
kubectl delete -f dist/west-infra.yaml --ignore-not-found 2>/dev/null || true

echo "  Waiting for Config Connector to delete GKE clusters..."
for name in gke-crdb-east gke-crdb-central gke-crdb-west; do
  kubectl wait --for=delete "containercluster/${name}" --timeout=600s 2>/dev/null || true
done

echo "==> Deleting shared infrastructure via Config Connector..."
kubectl delete -f dist/shared-infra.yaml --ignore-not-found 2>/dev/null || true

echo "  Waiting for VPC deletion..."
kubectl wait --for=delete computenetwork/crdb-multi-region --timeout=300s 2>/dev/null || true

# Step 4: Delete management cluster
echo "==> Deleting management cluster..."
gcloud container clusters delete gke-crdb-mgmt \
  --region us-central1 --project "${GCP_PROJECT_ID}" --quiet || true

# Step 5: Clean up GCS backup bucket
echo "==> Cleaning up GCS backup bucket..."
gcloud storage rm --recursive "gs://${GCP_PROJECT_ID}-crdb-backups" 2>/dev/null || true

# Step 6: Clean up Secret Manager secrets
echo "==> Cleaning up Secret Manager secrets..."
for secret in crdb-ca-crt crdb-node-crt crdb-node-key crdb-client-root-crt crdb-client-root-key; do
  gcloud secrets delete "${secret}" --project "${GCP_PROJECT_ID}" --quiet 2>/dev/null || true
done

# Step 7: Clean up Config Connector service account
echo "==> Cleaning up Config Connector service account..."
cc_sa_email="config-connector-sa@${GCP_PROJECT_ID}.iam.gserviceaccount.com"
for role in roles/editor roles/iam.securityAdmin roles/dns.admin roles/cloudkms.admin roles/secretmanager.admin; do
  gcloud projects remove-iam-policy-binding "${GCP_PROJECT_ID}" \
    --member "serviceAccount:${cc_sa_email}" \
    --role "$role" --quiet 2>/dev/null || true
done
gcloud iam service-accounts delete "${cc_sa_email}" \
  --project "${GCP_PROJECT_ID}" --quiet 2>/dev/null || true

# Step 8: Clean up local certs
rm -rf certs/

echo ""
echo "  NOTE: If you set up DNS delegation at your registrar, the NS records"
echo "  now point to deleted zones. Remove them to avoid stale DNS."

echo "==> Teardown complete"
