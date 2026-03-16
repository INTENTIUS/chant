#!/usr/bin/env bash
set -euo pipefail

kubectl delete -f k8s.yaml || true
echo "Waiting for ALB to drain..."
sleep 30
aws cloudformation delete-stack --stack-name eks-microservice
aws cloudformation wait stack-delete-complete --stack-name eks-microservice
