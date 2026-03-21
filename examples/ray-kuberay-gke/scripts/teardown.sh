#!/usr/bin/env bash
# teardown.sh — delete all ray-kuberay-gke resources.
#
# Deletes K8s resources from the workload cluster, then deletes GCP resources
# via Config Connector, then deletes both GKE clusters.
#
# Usage:
#   export GCP_PROJECT_ID=my-project
#   bash scripts/teardown.sh
set -euo pipefail

project_id="${GCP_PROJECT_ID:?Set GCP_PROJECT_ID}"
region="${GCP_REGION:-us-central1}"
cluster_name="${GKE_CLUSTER_NAME:-ray-gke}"
mgmt_cluster="ray-mgmt"

# ── Workload cluster — delete K8s resources ───────────────────────────────────

echo "==> Switching to workload cluster..."
gcloud container clusters get-credentials "$cluster_name" \
  --region "$region" --project "$project_id" 2>/dev/null || true

echo "==> Deleting K8s resources..."
kubectl delete -f k8s.yaml --ignore-not-found || true

echo "  Waiting for PVC/PV cleanup..."
sleep 20

# ── Management cluster — delete GCP resources via Config Connector ────────────

echo "==> Switching to management cluster..."
gcloud container clusters get-credentials "$mgmt_cluster" \
  --region "$region" --project "$project_id" 2>/dev/null || true

echo "==> Deleting Config Connector resources (GCP resources will be deleted)..."
kubectl delete -f config.yaml --ignore-not-found || true

echo "  Waiting for GCP resources to be deleted (~3 minutes)..."
sleep 180

# ── Delete GKE clusters ───────────────────────────────────────────────────────

echo "==> Deleting workload cluster: $cluster_name..."
gcloud container clusters delete "$cluster_name" \
  --region "$region" --project "$project_id" --quiet 2>/dev/null || true

echo "==> Deleting management cluster: $mgmt_cluster..."
gcloud container clusters delete "$mgmt_cluster" \
  --region "$region" --project "$project_id" --quiet 2>/dev/null || true

echo ""
echo "Teardown complete."
