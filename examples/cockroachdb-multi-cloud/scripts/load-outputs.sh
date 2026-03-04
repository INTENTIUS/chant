#!/usr/bin/env bash
# Fetch outputs from all 3 cloud deployments and write .env file.
# Run after infrastructure is deployed to get VPN public IPs, endpoints, etc.
set -euo pipefail

ENV_FILE="${1:-.env}"

echo "==> Loading outputs from all 3 clouds into ${ENV_FILE}"
: > "${ENV_FILE}"

# ── AWS EKS outputs ─────────────────────────────────────────────────
echo "  -> Fetching AWS CloudFormation outputs..."
if aws cloudformation describe-stacks --stack-name eks-cockroachdb --region us-east-1 > /dev/null 2>&1; then
  eval "$(aws cloudformation describe-stacks \
    --stack-name eks-cockroachdb \
    --region us-east-1 \
    --query 'Stacks[0].Outputs[*].[OutputKey,OutputValue]' \
    --output text | while IFS=$'\t' read -r key val; do
    echo "echo ${key}=${val} >> ${ENV_FILE}"
  done)"

  # Extract AWS VPN public IP from VPN connection tunnel outside address.
  # AWS VPN Gateways don't expose a public IP as a CloudFormation attribute.
  VPN_GW_ID=$(grep -s 'vpnGatewayId=' "${ENV_FILE}" | cut -d= -f2 || true)
  if [[ -n "${VPN_GW_ID}" ]]; then
    AWS_VPN_IP=$(aws ec2 describe-vpn-connections \
      --filters "Name=vpn-gateway-id,Values=${VPN_GW_ID}" \
      --region us-east-1 \
      --query 'VpnConnections[0].VgwTelemetry[0].OutsideIpAddress' \
      --output text 2>/dev/null || true)
    if [[ -n "${AWS_VPN_IP}" && "${AWS_VPN_IP}" != "None" ]]; then
      echo "AWS_VPN_PUBLIC_IP=${AWS_VPN_IP}" >> "${ENV_FILE}"
    fi
  fi
fi

# ── Azure AKS outputs ───────────────────────────────────────────────
echo "  -> Fetching Azure ARM deployment outputs..."
if az deployment group show --resource-group cockroachdb-rg --name aks-cockroachdb > /dev/null 2>&1; then
  az deployment group show \
    --resource-group cockroachdb-rg \
    --name aks-cockroachdb \
    --query 'properties.outputs' \
    -o tsv | while IFS=$'\t' read -r key _ val _; do
    echo "${key}=${val}" >> "${ENV_FILE}"
  done

  # Extract Azure VPN Gateway public IP
  AZURE_VPN_IP=$(az network public-ip show \
    --resource-group cockroachdb-rg \
    --name aks-cockroachdb-vpn-ip \
    --query 'ipAddress' -o tsv 2>/dev/null || true)
  if [[ -n "${AZURE_VPN_IP}" ]]; then
    echo "AZURE_VPN_PUBLIC_IP=${AZURE_VPN_IP}" >> "${ENV_FILE}"
  fi
fi

# ── GCP GKE outputs ─────────────────────────────────────────────────
echo "  -> Fetching GCP outputs..."
if gcloud container clusters describe gke-cockroachdb --region us-east4 --format json > /dev/null 2>&1; then
  ENDPOINT=$(gcloud container clusters describe gke-cockroachdb --region us-east4 --format 'value(endpoint)')
  echo "GKE_ENDPOINT=${ENDPOINT}" >> "${ENV_FILE}"
fi

# Extract GCP HA VPN Gateway public IP
GCP_VPN_IP=$(gcloud compute vpn-gateways describe gke-cockroachdb-vpn-gw \
  --region=us-east4 \
  --format='value(vpnInterfaces[0].ipAddress)' 2>/dev/null || true)
if [[ -n "${GCP_VPN_IP}" ]]; then
  echo "GCP_VPN_PUBLIC_IP=${GCP_VPN_IP}" >> "${ENV_FILE}"
fi

echo "==> Validating required outputs..."
missing=0
for var in AWS_VPN_PUBLIC_IP AZURE_VPN_PUBLIC_IP GCP_VPN_PUBLIC_IP; do
  if ! grep -q "^${var}=" "${ENV_FILE}"; then
    echo "  [ERROR] Missing ${var} — VPN connectivity will fail"
    missing=1
  fi
done
if [[ ${missing} -eq 1 ]]; then
  echo "  Some VPN IPs could not be resolved. Check that infra deployed successfully."
  exit 1
fi

echo "==> Outputs written to ${ENV_FILE}"
cat "${ENV_FILE}"
