#!/usr/bin/env bash
# deploy.sh — full GKE deployment for ray-kuberay-gke.
#
# Handles the two-phase build: GCP infra first (Config Connector),
# then K8s manifests (needs Filestore IP that's only available after infra).
#
# Usage:
#   export GCP_PROJECT_ID=my-project
#   bash scripts/deploy.sh
set -euo pipefail

project_id="${GCP_PROJECT_ID:?Set GCP_PROJECT_ID}"
region="${GCP_REGION:-us-central1}"
cluster_name="${GKE_CLUSTER_NAME:-ray-gke}"
filestore_name="${FILESTORE_NAME:-ray-filestore}"

echo "==> Building GCP infra manifests..."
npm run build:gcp

echo "==> Applying GCP infra via Config Connector..."
kubectl apply -f config.yaml

echo "==> Waiting for GCP resources to be ready (~10 minutes)..."
kubectl wait -f config.yaml --for=condition=Ready --timeout=600s

echo "==> Getting credentials for workload cluster..."
gcloud container clusters get-credentials "$cluster_name" \
  --region "$region" --project "$project_id"

echo "==> Installing KubeRay operator..."
helm repo add kuberay https://ray-project.github.io/kuberay-helm/ 2>/dev/null || true
helm repo update kuberay
helm upgrade --install kuberay-operator kuberay/kuberay-operator \
  -n kuberay-operator --create-namespace --version 1.3.2
kubectl -n kuberay-operator wait deploy/kuberay-operator \
  --for=condition=Available --timeout=120s

echo "==> Querying Filestore IP..."
filestore_ip=$(gcloud filestore instances describe "$filestore_name" \
  --zone "${region}-a" --project "$project_id" \
  --format='value(networks[0].ipAddresses[0])')
echo "  Filestore IP: $filestore_ip"

echo "==> Building K8s manifests..."
FILESTORE_IP="$filestore_ip" npm run build:k8s

echo "==> Applying K8s manifests..."
kubectl apply -f k8s.yaml

echo "==> Waiting for RayCluster to be ready (~5 minutes)..."
kubectl -n ray-system wait raycluster/ray \
  --for=jsonpath='{.status.state}'=ready --timeout=300s

echo ""
echo "Deploy complete."
