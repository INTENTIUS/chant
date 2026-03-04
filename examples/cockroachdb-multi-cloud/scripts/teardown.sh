#!/usr/bin/env bash
# Tear down the entire CockroachDB multi-cloud deployment.
# Destroys K8s resources first, then infrastructure.
set -euo pipefail

echo "==> Tearing down CockroachDB multi-cloud cluster"

# Step 1: Delete K8s resources (parallel)
echo "==> Deleting K8s resources..."
(
  kubectl --context eks delete -f dist/eks-k8s.yaml --ignore-not-found 2>/dev/null &
  kubectl --context aks delete -f dist/aks-k8s.yaml --ignore-not-found 2>/dev/null &
  # Ensure GKE context alias exists (may not if deploy was interrupted)
  gcloud container clusters get-credentials gke-cockroachdb --region us-east4 2>/dev/null || true
  kubectl config rename-context "$(kubectl config current-context)" gke 2>/dev/null || true
  kubectl --context gke delete -f dist/gke-k8s.yaml --ignore-not-found 2>/dev/null &
  wait
) || true

# Step 2: Delete PVCs (StatefulSet PVCs are not deleted automatically)
echo "==> Deleting PVCs..."
for ctx in eks aks gke; do
  ns="crdb-${ctx}"
  kubectl --context "${ctx}" -n "${ns}" delete pvc --all --ignore-not-found 2>/dev/null || true
done

# Step 3: Delete infrastructure (parallel)
echo "==> Deleting infrastructure..."
(
  aws cloudformation delete-stack --stack-name eks-cockroachdb --region us-east-1 &
  az group delete --name cockroachdb-rg --yes --no-wait &
  gcloud deployment-manager deployments delete gke-cockroachdb --quiet &
  wait
) || true

# Step 4: Wait for CloudFormation deletion
echo "==> Waiting for AWS stack deletion..."
aws cloudformation wait stack-delete-complete --stack-name eks-cockroachdb --region us-east-1 2>/dev/null || true

# Step 5: Clean up local certs
rm -rf certs/ .env

echo ""
echo "  NOTE: If you set up DNS delegation at your registrar, the NS records"
echo "  now point to deleted zones. Remove them to avoid stale DNS."

echo "==> Teardown complete"
