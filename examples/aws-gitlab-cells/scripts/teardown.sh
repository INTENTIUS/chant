#!/usr/bin/env bash
set -euo pipefail

STACK_NAME="${STACK_NAME:-cells-cluster}"
REGION="${AWS_REGION:-us-east-1}"

echo "Deleting K8s resources..."
kubectl delete -f k8s.yaml --ignore-not-found --timeout=120s || true

echo "Waiting for load balancer cleanup..."
sleep 30

echo "Deleting CloudFormation stack $STACK_NAME..."
aws cloudformation delete-stack --stack-name "$STACK_NAME" --region "$REGION"
aws cloudformation wait stack-delete-complete --stack-name "$STACK_NAME" --region "$REGION"

echo "Teardown complete."
