---
skill: chant-aks
description: End-to-end AKS workflow bridging Azure infrastructure and Kubernetes workloads
user-invocable: true
---

# AKS End-to-End Workflow

## Overview

This skill bridges two lexicons:
- **`@intentius/chant-lexicon-azure`** — AKS cluster, ACR, managed identities, role assignments, Azure DNS (ARM)
- **`@intentius/chant-lexicon-k8s`** — Kubernetes workloads, AKS Workload Identity, AGIC Ingress, storage, observability (K8s YAML)

## Architecture

```
Azure Lexicon (ARM)                      K8s Lexicon (kubectl apply)
┌──────────────────────────────┐        ┌──────────────────────────────────┐
│ VNet + Subnets + NSG         │        │ NamespaceEnv (quotas)            │
│ AKS Cluster                  │        │ AutoscaledService (app)          │
│ Container Registry (ACR)     │──IDs─→ │ AksWorkloadIdentityServiceAcct   │
│ Managed Identities           │        │ AgicIngress + AksExternalDns     │
│ Role Assignments             │        │ AzureDiskStorageClass            │
│ Azure DNS Zone               │        │ AzureMonitorCollector            │
└──────────────────────────────┘        └──────────────────────────────────┘
```

## Step 1: Deploy ARM Template

```bash
# Build ARM template
chant build src --lexicon azure -o template.json

# Deploy to Azure
npm run deploy-infra
# Runs: az deployment group create --resource-group $RESOURCE_GROUP --template-file template.json
```

Key Azure resources:
- **AKS Cluster** — control plane with SystemAssigned identity, OIDC issuer enabled
- **Container Registry** — Premium SKU, admin disabled
- **Managed Identities** — app, DNS, and monitoring identities
- **Role Assignments** — ACR Pull, DNS Zone Contributor, Monitoring Metrics Publisher
- **Azure DNS Zone** — for ExternalDNS

## Step 2: Configure kubectl

```bash
npm run configure-kubectl
# Runs: az aks get-credentials --resource-group $RESOURCE_GROUP --name $CLUSTER_NAME
kubectl get nodes  # verify connectivity
```

## Step 3: Load Outputs

```bash
npm run load-outputs
```

Populates `.env` with managed identity client IDs, ACR login server, and DNS zone info from the ARM deployment outputs.

## Step 4: Deploy K8s Workloads

```bash
npm run build:k8s    # Rebuild with real values from .env
npm run apply        # kubectl apply -f k8s.yaml
```

### Key K8s composites for AKS

```typescript
import {
  NamespaceEnv,
  AutoscaledService,
  AksWorkloadIdentityServiceAccount,
  AgicIngress,
  AksExternalDnsAgent,
  AzureDiskStorageClass,
  AzureMonitorCollector,
} from "@intentius/chant-lexicon-k8s";

// 1. Namespace with quotas and network isolation
const ns = NamespaceEnv({
  name: "prod",
  cpuQuota: "16",
  memoryQuota: "32Gi",
  defaultCpuRequest: "100m",
  defaultMemoryRequest: "128Mi",
  defaultDenyIngress: true,
});

// 2. AKS Workload Identity ServiceAccount (use client ID from ARM outputs)
const wi = AksWorkloadIdentityServiceAccount({
  name: "app-sa",
  clientId: "12345678-abcd-1234-abcd-123456789012",  // from .env
  namespace: "prod",
});

// 3. Application with autoscaling
const app = AutoscaledService({
  name: "api",
  image: "myacr.azurecr.io/api:1.0",
  port: 8080,
  maxReplicas: 10,
  cpuRequest: "200m",
  memoryRequest: "256Mi",
  namespace: "prod",
});

// 4. AGIC Ingress
const ingress = AgicIngress({
  name: "api-ingress",
  hosts: [
    {
      hostname: "api.example.com",
      paths: [{ path: "/", serviceName: "api", servicePort: 80 }],
    },
  ],
  healthCheckPath: "/healthz",
  namespace: "prod",
});

// 5. ExternalDNS for Azure DNS
const dns = AksExternalDnsAgent({
  clientId: "12345678-abcd-1234-abcd-123456789012",
  resourceGroup: "my-rg",
  subscriptionId: "sub-id",
  tenantId: "tenant-id",
  domainFilters: ["example.com"],
});

// 6. Storage
const storage = AzureDiskStorageClass({
  name: "premium-lrs",
  skuName: "Premium_LRS",
});

// 7. Observability
const monitor = AzureMonitorCollector({
  workspaceId: "/subscriptions/.../workspaces/my-workspace",
  clusterName: "my-cluster",
});
```

## Step 5: Verify

```bash
npm run status
kubectl get pods -n prod
kubectl get ingress -n prod
kubectl logs -n azure-monitor -l app.kubernetes.io/name=azure-monitor-collector
```

## Cleanup

```bash
npm run teardown
```

Delete order matters:
1. **K8s workloads** — drains load balancers, releases Application Gateway backends
2. **ARM deployment** — `az group delete` removes all Azure resources

## Cross-Lexicon Value Flow

ARM deployment outputs flow into K8s composite props via `.env`:

| ARM Output | K8s Composite Prop |
|-----------|-------------------|
| App identity client ID | `AksWorkloadIdentityServiceAccount.clientId` |
| DNS identity client ID | `AksExternalDnsAgent.clientId` |
| Monitor identity client ID | `AzureMonitorCollector.clientId` |
| ACR login server | `AutoscaledService.image` prefix |
| Subscription ID | `AksExternalDnsAgent.subscriptionId` |
| Tenant ID | `AksExternalDnsAgent.tenantId` |
| Resource group | `AksExternalDnsAgent.resourceGroup` |
| Log Analytics workspace ID | `AzureMonitorCollector.workspaceId` |
| Cluster name | `AzureMonitorCollector.clusterName` |

## OIDC Issuer + Federated Credentials

AKS Workload Identity requires:
1. **OIDC issuer** — enabled on the AKS cluster (ARM template sets `oidcIssuerProfile.enabled: true`)
2. **Federated credential** — links the K8s ServiceAccount to the Azure managed identity
3. **K8s annotation** — `azure.workload.identity/client-id` on the ServiceAccount (set by `AksWorkloadIdentityServiceAccount`)

The ARM template creates the federated credentials for each managed identity, binding them to specific `namespace:serviceAccountName` pairs. The K8s composite adds the client ID annotation.

## AKS Init Template

Scaffold a dual-lexicon AKS project:

```bash
chant init --lexicon azure --template aks
```

This creates:
- `src/infra/` — AKS cluster, ACR, managed identities, role assignments (Azure lexicon)
- `src/k8s/` — namespace, app, ingress, storage (K8s lexicon)
- `package.json` with both `@intentius/chant-lexicon-azure` and `@intentius/chant-lexicon-k8s`
