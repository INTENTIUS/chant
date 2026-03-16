#!/usr/bin/env bash
# Bootstrap a GKE management cluster with Config Connector.
#
# Config Connector runs on this cluster and creates all GCP infra
# (VPC, 3 workload GKE clusters, IAM, DNS) via kubectl apply.
set -euo pipefail

project_id="${GCP_PROJECT_ID:?Set GCP_PROJECT_ID}"
region="us-central1"
cluster_name="gke-crdb-mgmt"
cc_sa_name="config-connector-sa"
cc_sa_email="${cc_sa_name}@${project_id}.iam.gserviceaccount.com"

echo "==> Enabling required APIs..."
gcloud services enable container.googleapis.com dns.googleapis.com \
  iam.googleapis.com cloudresourcemanager.googleapis.com \
  cloudkms.googleapis.com secretmanager.googleapis.com \
  storage.googleapis.com compute.googleapis.com \
  --project "$project_id"

echo "==> Creating management GKE cluster with Workload Identity..."
if ! gcloud container clusters create "$cluster_name" \
  --region "$region" \
  --project "$project_id" \
  --machine-type e2-standard-2 \
  --num-nodes 2 \
  --workload-pool "${project_id}.svc.id.goog" \
  --release-channel regular \
  --disk-type pd-standard 2>&1; then
  echo "  Cluster may already exist, continuing..."
fi

echo "==> Getting credentials..."
gcloud container clusters get-credentials "$cluster_name" \
  --region "$region" --project "$project_id"

echo "==> Installing Config Connector operator..."
tmpdir=$(mktemp -d)
gsutil cp gs://configconnector-operator/latest/release-bundle.tar.gz "$tmpdir/release-bundle.tar.gz"
tar zxf "$tmpdir/release-bundle.tar.gz" -C "$tmpdir"
kubectl apply -f "$tmpdir/operator-system/configconnector-operator.yaml"
rm -rf "$tmpdir"
echo "  Waiting for operator to be ready..."
kubectl rollout status statefulset/configconnector-operator -n configconnector-operator-system \
  --timeout=300s

echo "==> Configuring Config Connector (namespaced mode)..."
kubectl apply -f - <<EOF
apiVersion: core.cnrm.cloud.google.com/v1beta1
kind: ConfigConnector
metadata:
  name: configconnector.core.cnrm.cloud.google.com
spec:
  mode: namespaced
EOF

echo "==> Creating Config Connector GCP service account..."
gcloud iam service-accounts create "$cc_sa_name" \
  --display-name "Config Connector SA" \
  --project "$project_id" 2>/dev/null || true
sleep 10

echo "==> Granting Config Connector SA project editor + IAM admin + DNS admin roles..."
for role in roles/editor roles/iam.securityAdmin roles/dns.admin roles/cloudkms.admin roles/secretmanager.admin; do
  gcloud projects add-iam-policy-binding "$project_id" \
    --member "serviceAccount:${cc_sa_email}" \
    --role "$role" --quiet
done

echo "==> Binding Config Connector SA to K8s SA via Workload Identity..."
gcloud iam service-accounts add-iam-policy-binding "$cc_sa_email" \
  --member "serviceAccount:${project_id}.svc.id.goog[cnrm-system/cnrm-controller-manager-default]" \
  --role roles/iam.workloadIdentityUser \
  --project "$project_id" --quiet

echo "==> Annotating default namespace with project ID..."
kubectl annotate namespace default "cnrm.cloud.google.com/project-id=${project_id}" --overwrite

echo "==> Creating ConfigConnectorContext for default namespace..."
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

echo "==> Waiting for Config Connector webhook to be ready..."
for i in $(seq 1 60); do
  if kubectl get pods -n cnrm-system -l cnrm.cloud.google.com/component=cnrm-webhook-manager --no-headers 2>/dev/null | grep -q Running; then
    break
  fi
  echo "  Waiting for webhook pod... ($i/60)"
  sleep 5
done
kubectl wait pod -n cnrm-system -l cnrm.cloud.google.com/component=cnrm-webhook-manager \
  --for=condition=Ready --timeout=300s
# Give the webhook endpoint time to register
sleep 10

echo ""
echo "Bootstrap complete. Config Connector is ready on cluster '${cluster_name}'."
echo "Next: npm run deploy"
