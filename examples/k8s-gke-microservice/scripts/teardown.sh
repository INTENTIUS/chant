#!/usr/bin/env bash
set -euo pipefail

kubectl delete -f k8s.yaml || true
echo "Waiting for load balancer to drain..."
sleep 30
kubectl delete -f config.yaml || true
