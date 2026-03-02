# k8s-aks-microservice

Production-grade AKS microservice with cross-lexicon builds — Azure infrastructure via ARM + Kubernetes workloads.

## What it builds

```
chant build src --lexicon azure → template.json  (ARM JSON)
chant build src --lexicon k8s   → k8s.yaml       (K8s workload YAML)
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Azure Lexicon (ARM)                                    │
│  ├── VNet + Subnets + NSG + Route Table                 │
│  ├── AKS Cluster (SystemAssigned identity)              │
│  ├── Container Registry (Premium, admin disabled)       │
│  ├── 3× Managed Identities (app, dns, monitor)         │
│  ├── Role Assignments (ACR Pull, DNS Contributor, etc.) │
│  └── Azure DNS Zone                                     │
└────────────────────┬────────────────────────────────────┘
                     │ client IDs via .env → config.ts
┌────────────────────▼────────────────────────────────────┐
│  K8s Lexicon                                            │
│  ├── Namespace (quotas, limits, network policy)         │
│  ├── AutoscaledService (Deployment + HPA + PDB)         │
│  ├── WorkloadIdentityServiceAccount (AKS)               │
│  ├── AGIC Ingress + AksExternalDnsAgent                 │
│  ├── AzureDiskStorageClass                              │
│  ├── AzureMonitorCollector                              │
│  └── MetricsServer                                      │
└─────────────────────────────────────────────────────────┘
```

## Source files

### `src/infra/` — Azure resources (ARM)

| File | Resources |
|------|-----------|
| `networking.ts` | VNet, 2 subnets, NSG, Route Table |
| `cluster.ts` | AKS cluster, ACR, 3 managed identities, role assignments |
| `dns.ts` | Azure DNS Zone |

### `src/k8s/` — Kubernetes workloads

| File | Resources |
|------|-----------|
| `namespace.ts` | Namespace, ResourceQuota, LimitRange, NetworkPolicy |
| `app.ts` | AutoscaledService, WorkloadIdentityServiceAccount, ConfigMap, MetricsServer |
| `ingress.ts` | AGIC Ingress, AksExternalDnsAgent |
| `storage.ts` | AzureDiskStorageClass |
| `observability.ts` | AzureMonitorCollector |

## Quick start (local verification)

```bash
cp .env.example .env
npm run build
npm run lint
```

## Deploy workflow

1. **Build**: `npm run build`
2. **Deploy infra**: `npm run deploy-infra` (requires Azure resource group)
3. **Configure kubectl**: `npm run configure-kubectl`
4. **Load outputs**: `npm run load-outputs`
5. **Rebuild K8s**: `npm run build:k8s`
6. **Apply workloads**: `npm run apply`
7. **Verify**: `npm run status`

## Standalone usage

Copy `package.standalone.json` to `package.json` and run `npm install`.
