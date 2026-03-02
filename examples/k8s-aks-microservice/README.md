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

## Skills guide

The lexicon packages (`@intentius/chant-lexicon-azure` and `@intentius/chant-lexicon-k8s`) ship four skills that guide your agent through every aspect of this example. After `chant init --lexicon azure` and `chant init --lexicon k8s`, your agent has access to:

### `chant-aks` — primary entry point

The **`chant-aks`** skill (Azure lexicon) covers the full end-to-end workflow:

- Deploying ARM templates (AKS cluster, ACR, managed identities, DNS)
- Deploying K8s workloads with real client IDs from ARM outputs
- Cross-lexicon value mapping: which ARM output feeds which K8s composite prop
- Scaffolding new projects with `chant init --lexicon azure --template aks`

### `chant-k8s-aks` — AKS-specific composites

Covers the composites used in `src/k8s/`:

| Composite | File | What it does |
|-----------|------|--------------|
| `AksWorkloadIdentityServiceAccount` | `app.ts` | AKS WI setup, `azure.workload.identity/client-id` annotation |
| `AgicIngress` | `ingress.ts` | Application Gateway annotations, health probes, WAF |
| `AksExternalDnsAgent` | `ingress.ts` | Azure DNS integration, Workload Identity |
| `AzureDiskStorageClass` | `storage.ts` | Azure Disk CSI provisioner, Premium_LRS |
| `AzureMonitorCollector` | `observability.ts` | DaemonSet config, Log Analytics pipeline |

### `chant-k8s` — core composites reference

Comprehensive reference for all 20 composites:

- **"Choosing the Right Composite" decision tree** — which composite for each workload type
- Hardening options: `minAvailable` (PDB), `initContainers`, `securityContext`, `priorityClassName`
- Build/lint/apply workflow and troubleshooting

### `chant-k8s-patterns` — advanced patterns

Patterns to add next:

- **Sidecars** — Envoy proxy or log forwarder with `SidecarApp`
- **Config/Secret mounting** — `ConfiguredApp` for ConfigMap volumes and Secret env vars
- **TLS with cert-manager** — `SecureIngress` for non-Azure ingress controllers
- **Prometheus monitoring** — `MonitoredService` with ServiceMonitor and alert rules

### Skill workflow

```
1. chant-aks           "Deploy an AKS project end-to-end"
   │                   → Scaffold, deploy ARM template, deploy workloads
   │
2. chant-k8s-aks       "Which AKS composites do I need?"
   │                   → WI, AGIC, Azure Disk/File, ExternalDNS, Monitor
   │
3. chant-k8s           "How do I choose between composites?"
   │                   → Decision tree, hardening options, troubleshooting
   │
4. chant-k8s-patterns  "What patterns can I add next?"
                       → Sidecars, monitoring, TLS, network isolation
```

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
