#!/usr/bin/env bash
set -euo pipefail

source .env

echo "Creating GKE cluster with Config Connector..."
gcloud container clusters create "$CLUSTER_NAME" \
  --region "$GCP_REGION" \
  --project "$GCP_PROJECT_ID" \
  --machine-type "$MACHINE_TYPE" \
  --num-nodes "$MIN_NODE_COUNT" \
  --max-nodes "$MAX_NODE_COUNT" \
  --enable-autoscaling \
  --workload-pool="${GCP_PROJECT_ID}.svc.id.goog" \
  --addons ConfigConnector \
  --release-channel regular \
  --disk-size "${NODE_DISK_SIZE_GB:-200}" \
  --enable-ip-alias

echo "Creating Config Connector service account..."
CC_SA="config-connector@${GCP_PROJECT_ID}.iam.gserviceaccount.com"
gcloud iam service-accounts create config-connector \
  --project "$GCP_PROJECT_ID" \
  --display-name "Config Connector SA" || true

for ROLE in roles/editor roles/iam.securityAdmin roles/dns.admin; do
  gcloud projects add-iam-policy-binding "$GCP_PROJECT_ID" \
    --member "serviceAccount:${CC_SA}" \
    --role "$ROLE" --condition=None
done

echo "Binding Config Connector SA to Workload Identity..."
gcloud iam service-accounts add-iam-policy-binding "$CC_SA" \
  --member "serviceAccount:${GCP_PROJECT_ID}.svc.id.goog[cnrm-system/cnrm-controller-manager]" \
  --role roles/iam.workloadIdentityUser

echo "Configuring Config Connector..."
kubectl apply -f - <<EOF
apiVersion: core.cnrm.cloud.google.com/v1beta1
kind: ConfigConnectorContext
metadata:
  name: configconnectorcontext.core.cnrm.cloud.google.com
  namespace: default
spec:
  googleServiceAccount: "$CC_SA"
EOF

echo "Bootstrap complete. Run 'npm run deploy' to deploy infrastructure."
