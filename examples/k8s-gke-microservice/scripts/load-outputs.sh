#!/usr/bin/env bash
set -euo pipefail

project_id="${GCP_PROJECT_ID:?Set GCP_PROJECT_ID}"
region="${GCP_REGION:-us-central1}"

cat > .env <<EOF
GCP_PROJECT_ID=${project_id}
GCP_REGION=${region}
GKE_CLUSTER_NAME=gke-microservice
APP_GSA_EMAIL=gke-microservice-app@${project_id}.iam.gserviceaccount.com
EXTERNAL_DNS_GSA_EMAIL=gke-microservice-dns@${project_id}.iam.gserviceaccount.com
FLUENT_BIT_GSA_EMAIL=gke-microservice-logging@${project_id}.iam.gserviceaccount.com
OTEL_GSA_EMAIL=gke-microservice-monitoring@${project_id}.iam.gserviceaccount.com
DOMAIN=api.gke-microservice-demo.dev
APP_IMAGE=nginxinc/nginx-unprivileged:stable
EOF

echo "Wrote .env with GCP service account emails"

# Show Cloud DNS nameservers if zone exists
ns=$(gcloud dns managed-zones describe gke-microservice-zone \
  --project "$project_id" --format='value(nameServers)' 2>/dev/null || true)
if [ -n "$ns" ]; then
  echo ""
  echo "Cloud DNS nameservers: $ns"
  echo "Update your domain registrar NS records to the nameservers above."
fi
