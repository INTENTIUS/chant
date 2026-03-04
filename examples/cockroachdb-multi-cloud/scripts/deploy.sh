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

echo "==> Pre-flight: checking required environment variables"
_missing=0
for var in ALB_CERT_ARN EXTERNAL_DNS_ROLE_ARN \
           AZURE_SUBSCRIPTION_ID AZURE_TENANT_ID EXTERNAL_DNS_CLIENT_ID \
           GCP_PROJECT_ID EXTERNAL_DNS_GSA_EMAIL \
           VPN_SHARED_SECRET; do
  if [[ -z "${!var:-}" ]]; then
    echo "  [ERROR] ${var} is not set"
    _missing=1
  fi
done
if [[ ${_missing} -eq 1 ]]; then
  echo "  Copy .env.example to .env, fill in values, and source it: set -a && source .env && set +a"
  exit 1
fi

if [[ "${VPN_SHARED_SECRET}" == "changeme" ]]; then
  echo "  [WARN] VPN_SHARED_SECRET is 'changeme' — use a strong secret for production"
fi

echo "==> Pre-flight: checking required tools"
for cmd in aws az gcloud kubectl docker; do
  if ! command -v "${cmd}" &>/dev/null; then
    echo "  [ERROR] ${cmd} is not installed or not in PATH"
    _missing=1
  fi
done
if [[ ${_missing} -eq 1 ]]; then
  echo "  Install missing tools before deploying. See README.md Prerequisites."
  exit 1
fi

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

echo ""
echo "  ┌─────────────────────────────────────────────────────────────────┐"
echo "  │ REMINDER: If this is your first deploy, you need to delegate   │"
echo "  │ DNS subdomains at your registrar after infra is up.            │"
echo "  │ See README.md → 'DNS Delegation (One-Time Setup)'             │"
echo "  │ This is only needed for public UI access, not cluster health.  │"
echo "  └─────────────────────────────────────────────────────────────────┘"
echo ""

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

echo "==> Step 4c: Wait for VPN tunnels to establish"
VPN_GW_ID=$(grep -s 'vpnGatewayId=' .env | cut -d= -f2)
if [[ -n "${VPN_GW_ID}" ]]; then
  echo "  Waiting for AWS VPN tunnels..."
  for i in $(seq 1 30); do
    UP_COUNT=$(aws ec2 describe-vpn-connections \
      --filters "Name=vpn-gateway-id,Values=${VPN_GW_ID}" \
      --region us-east-1 \
      --query 'VpnConnections[].VgwTelemetry[?Status==`UP`] | length(@)' \
      --output text 2>/dev/null || echo 0)
    if [[ "${UP_COUNT}" -ge 2 ]]; then
      echo "  VPN tunnels UP (${UP_COUNT} tunnels active)"
      break
    fi
    echo "  Tunnels UP: ${UP_COUNT}/2 — waiting... (${i}/30)"
    sleep 10
  done
fi

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
  kubectl --context "${ctx}" -n kube-system rollout restart deployment/coredns ||
    echo "  [warn] CoreDNS restart failed on ${ctx} — config will take effect on next pod restart"
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
