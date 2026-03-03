#!/usr/bin/env bash
set -euo pipefail

project_id="${GCP_PROJECT_ID:?Set GCP_PROJECT_ID}"
region="${GCP_REGION:-us-central1}"
cluster_name="gke-microservice"
cc_sa_name="config-connector-sa"
cc_sa_email="${cc_sa_name}@${project_id}.iam.gserviceaccount.com"

echo "==> Enabling required APIs..."
gcloud services enable container.googleapis.com dns.googleapis.com \
  iam.googleapis.com cloudresourcemanager.googleapis.com \
  --project "$project_id"

echo "==> Creating GKE cluster with Config Connector + Workload Identity..."
if ! gcloud container clusters create "$cluster_name" \
  --region "$region" \
  --project "$project_id" \
  --machine-type e2-standard-4 \
  --num-nodes 1 \
  --workload-pool "${project_id}.svc.id.goog" \
  --addons ConfigConnector \
  --release-channel regular 2>&1; then
  echo "  Cluster may already exist, continuing..."
fi

echo "==> Getting credentials..."
gcloud container clusters get-credentials "$cluster_name" \
  --region "$region" --project "$project_id"

echo "==> Creating Config Connector GCP service account..."
gcloud iam service-accounts create "$cc_sa_name" \
  --display-name "Config Connector SA" \
  --project "$project_id" 2>/dev/null || true
# Wait for SA to propagate (eventual consistency)
sleep 10

echo "==> Granting Config Connector SA project editor + IAM admin roles..."
for role in roles/editor roles/iam.securityAdmin roles/dns.admin; do
  gcloud projects add-iam-policy-binding "$project_id" \
    --member "serviceAccount:${cc_sa_email}" \
    --role "$role" --quiet
done

echo "==> Binding Config Connector SA to K8s SA via Workload Identity..."
gcloud iam service-accounts add-iam-policy-binding "$cc_sa_email" \
  --member "serviceAccount:${project_id}.svc.id.goog[cnrm-system/cnrm-controller-manager]" \
  --role roles/iam.workloadIdentityUser \
  --project "$project_id" --quiet

echo "==> Creating ConfigConnectorContext..."
kubectl apply -f - <<EOF
apiVersion: core.cnrm.cloud.google.com/v1beta1
kind: ConfigConnectorContext
metadata:
  name: configconnectorcontext.core.cnrm.cloud.google.com
  namespace: default
spec:
  googleServiceAccount: "${cc_sa_email}"
EOF

echo "==> Waiting for Config Connector controller pod to appear..."
for i in $(seq 1 60); do
  if kubectl get pods -n cnrm-system -l cnrm.cloud.google.com/component=cnrm-controller-manager --no-headers 2>/dev/null | grep -q .; then
    break
  fi
  echo "  Waiting for controller pod... ($i/60)"
  sleep 5
done

echo "==> Waiting for Config Connector controller to be ready..."
kubectl wait pod -n cnrm-system -l cnrm.cloud.google.com/component=cnrm-controller-manager \
  --for=condition=Ready --timeout=300s

echo "Bootstrap complete. Config Connector is ready."
echo "Next: export GCP_PROJECT_ID=${project_id} && npm run deploy"
