#!/usr/bin/env bash
set -euo pipefail

project_id="${GCP_PROJECT_ID:?Set GCP_PROJECT_ID}"
region="${GCP_REGION:-us-central1}"
cluster_name="gke-microservice"

echo "==> Deleting K8s workloads..."
kubectl delete -f k8s.yaml --ignore-not-found || true
echo "Waiting for load balancer to drain..."
sleep 30

echo "==> Deleting Config Connector resources..."
kubectl delete -f config.yaml --ignore-not-found || true
echo "Waiting for GCP resources to be deleted..."
sleep 60

echo "==> Deleting Config Connector SA..."
cc_sa_email="config-connector-sa@${project_id}.iam.gserviceaccount.com"
gcloud iam service-accounts delete "$cc_sa_email" --project "$project_id" --quiet 2>/dev/null || true

echo "==> Deleting GKE cluster..."
gcloud container clusters delete "$cluster_name" \
  --region "$region" --project "$project_id" --quiet

echo "Teardown complete."
