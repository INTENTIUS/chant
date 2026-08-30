import type { ChantConfig } from "@intentius/chant";

/**
 * Every per-deployment value is a build-time parameter, not a `process.env`
 * read in source. The `env` mapping keeps `set -a && source .env` working;
 * the read itself is declared, validated, and resolved once before any
 * project file loads, so the in-process and sandboxed builds see the same
 * values (chant #1728).
 *
 * In production, populate these from ARM deployment outputs:
 *   az deployment group show --resource-group aks-microservice-rg \
 *     --name aks-microservice --query properties.outputs
 */
const ZERO_GUID = "00000000-0000-0000-0000-000000000000";

export default {
  lexicons: ["azure", "k8s"],
  buildParams: {
    clusterName: { type: "string", default: "aks-microservice", env: "AKS_CLUSTER_NAME" },
    resourceGroup: { type: "string", default: "aks-microservice-rg", env: "AZURE_RESOURCE_GROUP" },
    subscriptionId: { type: "string", default: ZERO_GUID, env: "AZURE_SUBSCRIPTION_ID" },
    tenantId: { type: "string", default: ZERO_GUID, env: "AZURE_TENANT_ID" },
    appClientId: { type: "string", default: ZERO_GUID, env: "APP_CLIENT_ID" },
    externalDnsClientId: { type: "string", default: ZERO_GUID, env: "EXTERNAL_DNS_CLIENT_ID" },
    monitorClientId: { type: "string", default: ZERO_GUID, env: "MONITOR_CLIENT_ID" },
    domain: { type: "string", default: "api.aks-microservice-demo.dev", env: "DOMAIN" },
    appImage: { type: "string", default: "nginxinc/nginx-unprivileged:stable", env: "APP_IMAGE" },
  },
} satisfies ChantConfig;
