#!/usr/bin/env bash
set -euo pipefail

source .env

echo "=== Enabling required GCP APIs ==="
gcloud services enable \
  container.googleapis.com \
  dns.googleapis.com \
  iam.googleapis.com \
  cloudresourcemanager.googleapis.com \
  cloudkms.googleapis.com \
  secretmanager.googleapis.com \
  storage.googleapis.com \
  sqladmin.googleapis.com \
  redis.googleapis.com \
  servicenetworking.googleapis.com \
  --project "$GCP_PROJECT_ID"

echo "=== Creating GKE cluster with Config Connector ==="
gcloud container clusters create "${CLUSTER_NAME:-gitlab-cells}" \
  --region "$GCP_REGION" \
  --project "$GCP_PROJECT_ID" \
  --machine-type "${MACHINE_TYPE:-e2-standard-8}" \
  --num-nodes "${MIN_NODE_COUNT:-3}" \
  --max-nodes "${MAX_NODE_COUNT:-20}" \
  --enable-autoscaling \
  --workload-pool="${GCP_PROJECT_ID}.svc.id.goog" \
  --addons ConfigConnector \
  --release-channel regular \
  --disk-size "${NODE_DISK_SIZE_GB:-200}" \
  --enable-ip-alias

echo "=== Getting cluster credentials ==="
gcloud container clusters get-credentials "${CLUSTER_NAME:-gitlab-cells}" \
  --region "$GCP_REGION" --project "$GCP_PROJECT_ID"

echo "=== Creating Config Connector service account ==="
CC_SA="config-connector@${GCP_PROJECT_ID}.iam.gserviceaccount.com"
gcloud iam service-accounts create config-connector \
  --project "$GCP_PROJECT_ID" \
  --display-name "Config Connector SA" || true

for ROLE in \
  roles/editor \
  roles/iam.securityAdmin \
  roles/dns.admin \
  roles/cloudkms.admin \
  roles/secretmanager.admin; do
  gcloud projects add-iam-policy-binding "$GCP_PROJECT_ID" \
    --member "serviceAccount:${CC_SA}" \
    --role "$ROLE" --condition=None
done

echo "=== Binding Config Connector SA to Workload Identity ==="
# Config Connector add-on uses cnrm-controller-manager-default (not cnrm-controller-manager)
gcloud iam service-accounts add-iam-policy-binding "$CC_SA" \
  --member "serviceAccount:${GCP_PROJECT_ID}.svc.id.goog[cnrm-system/cnrm-controller-manager-default]" \
  --role roles/iam.workloadIdentityUser

echo "=== Configuring Config Connector ==="
kubectl apply -f - <<EOF
apiVersion: core.cnrm.cloud.google.com/v1beta1
kind: ConfigConnectorContext
metadata:
  name: configconnectorcontext.core.cnrm.cloud.google.com
  namespace: default
spec:
  googleServiceAccount: "$CC_SA"
EOF

echo "=== Waiting for Config Connector CRDs to register (up to 3 min) ==="
until kubectl get crd sqlinstances.sql.cnrm.cloud.google.com &>/dev/null; do
  sleep 10
  echo "  still waiting for CRDs..."
done
echo "  CRDs registered."

echo "=== Waiting for Config Connector webhook pod ==="
kubectl -n cnrm-system wait --for=condition=Ready pod \
  -l cnrm.cloud.google.com/component=cnrm-webhook-manager --timeout=180s

echo "Bootstrap complete. Run 'npm run deploy' to deploy infrastructure."
