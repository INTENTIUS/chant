#!/usr/bin/env bash
set -euo pipefail

kubectl delete -f k8s.yaml || true
echo "Waiting for load balancer to drain..."
sleep 30
az group delete --name "${AZURE_RESOURCE_GROUP:-aks-microservice-rg}" --yes --no-wait
echo "Resource group deletion initiated (runs in background)"
