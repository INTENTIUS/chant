// AKS-specific configuration. Extends shared cluster config.

import { CRDB_CLUSTER, CRDB_DOMAIN } from "../shared/config";

export const config = {
  ...CRDB_CLUSTER,
  clusterName: process.env.AKS_CLUSTER_NAME ?? "aks-cockroachdb",
  resourceGroup: process.env.AZURE_RESOURCE_GROUP ?? "cockroachdb-rg",
  subscriptionId: process.env.AZURE_SUBSCRIPTION_ID ?? "00000000-0000-0000-0000-000000000000",
  tenantId: process.env.AZURE_TENANT_ID ?? "00000000-0000-0000-0000-000000000000",
  region: "eastus",
  namespace: "crdb-aks",
  locality: "cloud=azure,region=eastus",
  domain: `aks.${CRDB_DOMAIN}`,
  externalDnsClientId: process.env.EXTERNAL_DNS_CLIENT_ID ?? "00000000-0000-0000-0000-000000000000",
};
