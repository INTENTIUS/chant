#!/usr/bin/env bash
# Deploy CockroachDB multi-cloud cluster: all 3 clouds in sequence.
#
# Flow:
#   1.  Build all stacks (infra + K8s)
#   1b. Ensure Azure resource group exists
#   2.  Deploy infra (3 clouds in parallel)
#   3.  Load outputs (VPN IPs, endpoints)
#   4.  Rebuild with real VPN IPs
#   4b. Re-deploy infra with real VPN IPs
#   5.  Configure kubectl contexts
#   6.  Generate and distribute TLS certs
#   7.  Apply K8s manifests (3 clusters in parallel)
#   8.  Restart CoreDNS
#   9.  Wait for StatefulSets
#  10.  Run cockroach init
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT_DIR}"

echo "==> Step 1: Build all stacks"
npm run build

echo "==> Step 1b: Ensure Azure resource group exists"
az group create --name cockroachdb-rg --location eastus 2>/dev/null || true

echo "==> Step 2: Deploy infrastructure (parallel)"
(
  aws cloudformation deploy \
    --template-file dist/eks-infra.json \
    --stack-name eks-cockroachdb \
    --capabilities CAPABILITY_NAMED_IAM \
    --region us-east-1 &

  az deployment group create \
    --resource-group cockroachdb-rg \
    --name aks-cockroachdb \
    --template-file dist/aks-infra.json &

  gcloud deployment-manager deployments create gke-cockroachdb \
    --config dist/gke-infra.json &

  wait
)

echo "==> Step 3: Load outputs from all clouds"
bash scripts/load-outputs.sh

echo "==> Step 4: Rebuild with real VPN IPs"
set -a && source .env && set +a
npm run build

echo "==> Step 4b: Re-deploy infrastructure with real VPN IPs (parallel)"
(
  aws cloudformation deploy \
    --template-file dist/eks-infra.json \
    --stack-name eks-cockroachdb \
    --capabilities CAPABILITY_NAMED_IAM \
    --region us-east-1 &

  az deployment group create \
    --resource-group cockroachdb-rg \
    --name aks-cockroachdb \
    --template-file dist/aks-infra.json &

  gcloud deployment-manager deployments update gke-cockroachdb \
    --config dist/gke-infra.json &

  wait
)

echo "==> Step 5: Configure kubectl contexts"
aws eks update-kubeconfig --name eks-cockroachdb --region us-east-1 --alias eks
az aks get-credentials --resource-group cockroachdb-rg --name aks-cockroachdb --context aks
gcloud container clusters get-credentials gke-cockroachdb --region us-east4
kubectl config rename-context "$(kubectl config current-context)" gke

echo "==> Step 6: Generate and distribute TLS certificates"
bash scripts/generate-certs.sh

echo "==> Step 7: Apply K8s manifests (parallel)"
(
  kubectl --context eks apply -f dist/eks-k8s.yaml &
  kubectl --context aks apply -f dist/aks-k8s.yaml &
  kubectl --context gke apply -f dist/gke-k8s.yaml &
  wait
)

echo "==> Step 8: Restart CoreDNS to pick up cross-cluster forwarding config"
for ctx in eks aks gke; do
  kubectl --context "${ctx}" -n kube-system rollout restart deployment/coredns 2>/dev/null || true
done

echo "==> Step 9: Wait for StatefulSets to be ready"
kubectl --context eks -n crdb-eks rollout status statefulset/cockroachdb --timeout=300s
kubectl --context aks -n crdb-aks rollout status statefulset/cockroachdb --timeout=300s
kubectl --context gke -n crdb-gke rollout status statefulset/cockroachdb --timeout=300s

echo "==> Step 10: Initialize CockroachDB cluster"
kubectl --context eks exec cockroachdb-0 -n crdb-eks -- \
  /cockroach/cockroach init --certs-dir=/cockroach/cockroach-certs

echo "==> CockroachDB multi-cloud cluster is ready!"
echo "    EKS UI: https://eks.crdb.intentius.io"
echo "    AKS UI: https://aks.crdb.intentius.io"
echo "    GKE UI: https://gke.crdb.intentius.io"
echo ""
echo "    SQL:  kubectl --context eks exec -it cockroachdb-0 -n crdb-eks -- \\"
echo "          /cockroach/cockroach sql --certs-dir=/cockroach/cockroach-certs"
