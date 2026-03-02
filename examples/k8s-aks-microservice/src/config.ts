// Cross-lexicon configuration.
// In production, populate these from ARM deployment outputs:
//   az deployment group show --resource-group aks-microservice-rg \
//     --name aks-microservice --query properties.outputs

export const config = {
  clusterName: process.env.AKS_CLUSTER_NAME ?? "aks-microservice",
  resourceGroup: process.env.AZURE_RESOURCE_GROUP ?? "aks-microservice-rg",
  subscriptionId: process.env.AZURE_SUBSCRIPTION_ID ?? "00000000-0000-0000-0000-000000000000",
  tenantId: process.env.AZURE_TENANT_ID ?? "00000000-0000-0000-0000-000000000000",
  appClientId: process.env.APP_CLIENT_ID ?? "00000000-0000-0000-0000-000000000000",
  externalDnsClientId: process.env.EXTERNAL_DNS_CLIENT_ID ?? "00000000-0000-0000-0000-000000000000",
  monitorClientId: process.env.MONITOR_CLIENT_ID ?? "00000000-0000-0000-0000-000000000000",
  domain: process.env.DOMAIN ?? "api.aks-microservice-demo.dev",
  appImage: process.env.APP_IMAGE ?? "nginxinc/nginx-unprivileged:stable",
};
