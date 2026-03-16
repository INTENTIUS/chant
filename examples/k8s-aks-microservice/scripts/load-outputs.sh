#!/usr/bin/env bash
set -euo pipefail

rg="${AZURE_RESOURCE_GROUP:?Set AZURE_RESOURCE_GROUP}"

outputs=$(az deployment group show --resource-group "$rg" --name aks-microservice --query properties.outputs --output json 2>/dev/null || echo "{}")

get_output() {
  echo "$outputs" | jq -r ".$1.value // empty"
}

subscription_id=$(az account show --query id --output tsv)
tenant_id=$(az account show --query tenantId --output tsv)

app_client_id=$(az identity show --name aks-microservice-app-id --resource-group "$rg" --query clientId --output tsv 2>/dev/null || echo "")
dns_client_id=$(az identity show --name aks-microservice-dns-id --resource-group "$rg" --query clientId --output tsv 2>/dev/null || echo "")
monitor_client_id=$(az identity show --name aks-microservice-monitor-id --resource-group "$rg" --query clientId --output tsv 2>/dev/null || echo "")

cat > .env <<EOF
AZURE_RESOURCE_GROUP=${rg}
AZURE_SUBSCRIPTION_ID=${subscription_id}
AZURE_TENANT_ID=${tenant_id}
AKS_CLUSTER_NAME=aks-microservice
APP_CLIENT_ID=${app_client_id}
EXTERNAL_DNS_CLIENT_ID=${dns_client_id}
MONITOR_CLIENT_ID=${monitor_client_id}
DOMAIN=api.aks-microservice-demo.dev
APP_IMAGE=nginxinc/nginx-unprivileged:stable
EOF

echo "Wrote .env with managed identity client IDs"
