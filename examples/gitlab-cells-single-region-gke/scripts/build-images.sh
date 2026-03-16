#!/usr/bin/env bash
set -euo pipefail

set -a; source .env; set +a

REGISTRY="${REGISTRY:-gcr.io/${GCP_PROJECT_ID}}"

echo "=== Building and pushing cell-router image ==="
docker build --platform linux/amd64 -t "${REGISTRY}/cell-router:latest" cell-router/
docker push "${REGISTRY}/cell-router:latest"

echo "=== Building and pushing topology-service image ==="
docker build --platform linux/amd64 -t "${REGISTRY}/topology-service:latest" topology-service/
docker push "${REGISTRY}/topology-service:latest"

echo "Images pushed:"
echo "  ${REGISTRY}/cell-router:latest"
echo "  ${REGISTRY}/topology-service:latest"
