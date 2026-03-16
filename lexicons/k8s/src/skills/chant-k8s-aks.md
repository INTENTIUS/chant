---
skill: chant-k8s-aks
description: AKS-specific Kubernetes patterns and composites
user-invocable: true
---

# AKS Kubernetes Patterns

## AKS Composites Overview

These composites produce K8s YAML with AKS-specific annotations and configurations.

### AksWorkloadIdentityServiceAccount — ServiceAccount with Azure client ID annotation

```typescript
import { AksWorkloadIdentityServiceAccount } from "@intentius/chant-lexicon-k8s";

const { serviceAccount, role, roleBinding } = AksWorkloadIdentityServiceAccount({
  name: "app-sa",
  clientId: "12345678-abcd-1234-abcd-123456789012",
  rbacRules: [
    { apiGroups: [""], resources: ["secrets"], verbs: ["get"] },
  ],
  namespace: "prod",
});
```

Annotates the ServiceAccount with `azure.workload.identity/client-id` for AKS Workload Identity.

### AgicIngress — Ingress with Application Gateway annotations

```typescript
import { AgicIngress } from "@intentius/chant-lexicon-k8s";

const { ingress } = AgicIngress({
  name: "api-ingress",
  hosts: [
    {
      hostname: "api.example.com",
      paths: [{ path: "/", serviceName: "api", servicePort: 80 }],
    },
  ],
  certificateArn: "keyvault-cert-name",
  healthCheckPath: "/healthz",
  wafPolicyId: "/subscriptions/.../applicationGatewayWebApplicationFirewallPolicies/my-waf",
  cookieAffinity: false,
});
```

Features:
- Auto-sets `appgw.ingress.kubernetes.io/*` annotations
- SSL redirect enabled by default when `certificateArn` set
- `wafPolicyId` for WAFv2 integration
- `healthCheckPath` for backend health probes
- `cookieAffinity` for session persistence

### AzureDiskStorageClass — StorageClass for Azure Disk CSI

```typescript
import { AzureDiskStorageClass } from "@intentius/chant-lexicon-k8s";

const { storageClass } = AzureDiskStorageClass({
  name: "premium-lrs",
  skuName: "Premium_LRS",
  cachingMode: "ReadOnly",
  allowVolumeExpansion: true,
});
```

SKU options: `Premium_LRS`, `StandardSSD_LRS`, `Standard_LRS`, `UltraSSD_LRS`.

### AzureFileStorageClass — StorageClass for Azure Files CSI (ReadWriteMany)

```typescript
import { AzureFileStorageClass } from "@intentius/chant-lexicon-k8s";

const { storageClass } = AzureFileStorageClass({
  name: "azure-files-premium",
  skuName: "Premium_LRS",
  protocol: "smb",
});
```

Protocol options: `smb` (default), `nfs`. Use Azure Files when you need ReadWriteMany (shared across pods/nodes). Use Azure Disk for ReadWriteOnce (single pod).

### AksExternalDnsAgent — ExternalDNS for Azure DNS

```typescript
import { AksExternalDnsAgent } from "@intentius/chant-lexicon-k8s";

const result = AksExternalDnsAgent({
  clientId: "12345678-abcd-1234-abcd-123456789012",
  resourceGroup: "my-rg",
  subscriptionId: "sub-id",
  tenantId: "tenant-id",
  domainFilters: ["example.com"],
  txtOwnerId: "my-cluster",
});
```

### AzureMonitorCollector — Azure Monitor + OTel for Log Analytics

```typescript
import { AzureMonitorCollector } from "@intentius/chant-lexicon-k8s";

const result = AzureMonitorCollector({
  workspaceId: "/subscriptions/.../workspaces/my-workspace",
  clusterName: "my-cluster",
  clientId: "12345678-abcd-1234-abcd-123456789012",
});
```

## AKS Workload Identity vs Pod-Managed Identity

| Feature | Workload Identity | Pod-Managed Identity (deprecated) |
|---------|------------------|----------------------------------|
| K8s annotation needed | Yes (`azure.workload.identity/client-id`) | Yes (`aadpodidbinding` label) |
| Composite available | **AksWorkloadIdentityServiceAccount** | None (deprecated) |
| Setup | OIDC issuer + federated credential | AzureIdentity + AzureIdentityBinding CRDs |
| Security | OIDC token exchange, no NMI pod | NMI DaemonSet intercepts IMDS calls |
| When to use | Always (recommended) | Legacy only, migrate to Workload Identity |

Pod-managed identity (AAD Pod Identity v1) is deprecated. Always use AKS Workload Identity for new workloads.

## AGIC Considerations

Application Gateway Ingress Controller (AGIC) manages an Azure Application Gateway:
- **Application Gateway provisioned in ARM** — the gateway itself is an Azure resource created by the ARM template
- **AGIC addon** — runs as a pod in the cluster, watches Ingress resources and configures the gateway
- **Backend pools** — AGIC automatically adds pod IPs to the Application Gateway backend pool
- **Health probes** — set `healthCheckPath` for proper backend health checking
- **WAF integration** — attach a WAF policy via `wafPolicyId` for L7 protection
- **TLS termination** — reference Key Vault certificates via `certificateArn` (the certificate URI or secret name)

## AKS Add-ons

Common add-ons managed via AKS (not K8s manifests):
- **AGIC** — Application Gateway Ingress Controller (required for AgicIngress)
- **Azure Monitor (Container Insights)** — alternative to AzureMonitorCollector for managed monitoring
- **AKS Workload Identity** — OIDC-based identity federation (required for AksWorkloadIdentityServiceAccount)
- **Azure Disk CSI driver** — enabled by default, required for AzureDiskStorageClass
- **Azure Files CSI driver** — enabled by default, required for AzureFileStorageClass
- **Azure Key Vault Secrets Provider** — sync Key Vault secrets to K8s Secrets
- **Azure Policy** — enforce governance policies on cluster resources

Configure add-ons via the Azure lexicon (`@intentius/chant-lexicon-azure`) ARM resources.
