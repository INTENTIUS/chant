#!/usr/bin/env bash
set -euo pipefail

# Source .env if present; otherwise rely on exported environment variables.
[ -f .env ] && { set -a; source .env; set +a; }

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
  artifactregistry.googleapis.com \
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
if gcloud container clusters describe "${CLUSTER_NAME:-gitlab-cells}" \
     --region "$GCP_REGION" --project "$GCP_PROJECT_ID" &>/dev/null; then
  echo "  Cluster already exists — skipping creation."
else
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
    --addons ConfigConnector,NetworkPolicy \
    --enable-network-policy \
    --release-channel regular \
    --disk-size "${NODE_DISK_SIZE_GB:-200}" \
    --enable-ip-alias
fi

echo "=== Waiting for cluster to be RUNNING ==="
until [ "$(gcloud container clusters describe "${CLUSTER_NAME:-gitlab-cells}" \
           --region "$GCP_REGION" --project "$GCP_PROJECT_ID" \
           --format='value(status)' 2>/dev/null)" = "RUNNING" ]; do
  echo "  cluster status: $(gcloud container clusters describe "${CLUSTER_NAME:-gitlab-cells}" \
    --region "$GCP_REGION" --project "$GCP_PROJECT_ID" \
    --format='value(status)' 2>/dev/null) — waiting 30s..."
  sleep 30
done
echo "  Cluster is RUNNING."

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
# ConfigConnectorContext is declared in src/system/config-connector.ts (K8s lexicon).
# Build k8s.yaml and apply only the bootstrap-labelled resources.
npm run build:k8s
# Extract only bootstrap-labelled resources into a temp file so kubectl doesn't try to
# resolve CRDs for ExternalSecret / Certificate / etc. that aren't installed yet.
python3 -c "
import yaml, sys
docs = [d for d in yaml.safe_load_all(open('k8s.yaml')) if d
        and d.get('metadata', {}).get('labels', {}).get('app.kubernetes.io/part-of') == 'bootstrap']
sys.stdout.write(yaml.dump_all(docs, default_flow_style=False))
" | kubectl apply -f -

echo "=== Waiting for Config Connector CRDs to register (up to 3 min) ==="
until kubectl get crd sqlinstances.sql.cnrm.cloud.google.com &>/dev/null; do
  sleep 10
  echo "  still waiting for CRDs..."
done
echo "  CRDs registered."

echo "=== Waiting for Config Connector webhook pod ==="
kubectl -n cnrm-system wait --for=condition=Ready pod \
  -l cnrm.cloud.google.com/component=cnrm-webhook-manager --timeout=180s

echo "=== Installing External Secrets Operator ==="
helm repo add external-secrets https://charts.external-secrets.io --force-update
helm upgrade --install external-secrets external-secrets/external-secrets \
  -n kube-system \
  --set installCRDs=true \
  --wait --timeout=5m

echo "=== Installing cert-manager ==="
helm repo add jetstack https://charts.jetstack.io --force-update
helm upgrade --install cert-manager jetstack/cert-manager \
  -n cert-manager --create-namespace \
  --set crds.enabled=true \
  --wait --timeout=5m

# Annotate the cert-manager controller SA for Workload Identity (DNS-01 solver).
# The GCP SA + WI binding are declared in src/gcp/iam.ts; this applies the K8s side.
kubectl annotate serviceaccount cert-manager -n cert-manager \
  "iam.gke.io/gcp-service-account=gitlab-cert-manager@${GCP_PROJECT_ID}.iam.gserviceaccount.com" \
  --overwrite

echo "=== Installing prometheus-operator CRDs (ServiceMonitor, PrometheusRule) ==="
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts --force-update
helm upgrade --install prometheus-operator-crds prometheus-community/prometheus-operator-crds \
  --wait --timeout=2m

echo "Bootstrap complete. Run 'npm run deploy' to deploy infrastructure."
