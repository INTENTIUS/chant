#!/usr/bin/env bash
set -euo pipefail

set -a; source .env; set +a

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

echo "=== Creating VPC network and subnet (idempotent) ==="
gcloud compute networks create "${CLUSTER_NAME:-gitlab-cells}" \
  --subnet-mode=custom --project "$GCP_PROJECT_ID" 2>/dev/null || true

gcloud compute networks subnets create "${CLUSTER_NAME:-gitlab-cells}-nodes" \
  --network="${CLUSTER_NAME:-gitlab-cells}" \
  --region "$GCP_REGION" \
  --range=10.0.0.0/20 \
  --secondary-range=pods=10.4.0.0/14,services=10.8.0.0/20 \
  --project "$GCP_PROJECT_ID" 2>/dev/null || true

echo "=== Enabling Private Service Access for Cloud SQL + Memorystore ==="
# Use same name that Config Connector will manage (enables CC adoption)
gcloud compute addresses create "${CLUSTER_NAME:-gitlab-cells}-private-address" \
  --global --purpose=VPC_PEERING --prefix-length=16 \
  --network="${CLUSTER_NAME:-gitlab-cells}" \
  --project "$GCP_PROJECT_ID" 2>/dev/null || true

gcloud services vpc-peerings connect \
  --service=servicenetworking.googleapis.com \
  --ranges="${CLUSTER_NAME:-gitlab-cells}-private-address" \
  --network="${CLUSTER_NAME:-gitlab-cells}" \
  --project "$GCP_PROJECT_ID" || true

echo "=== Creating GKE cluster with Config Connector ==="
gcloud container clusters create "${CLUSTER_NAME:-gitlab-cells}" \
  --region "$GCP_REGION" \
  --project "$GCP_PROJECT_ID" \
  --network "${CLUSTER_NAME:-gitlab-cells}" \
  --subnetwork "${CLUSTER_NAME:-gitlab-cells}-nodes" \
  --cluster-secondary-range-name pods \
  --services-secondary-range-name services \
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

echo "=== Annotating default namespace with project ID ==="
kubectl annotate namespace default \
  cnrm.cloud.google.com/project-id="$GCP_PROJECT_ID" --overwrite

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
