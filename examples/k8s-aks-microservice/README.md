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
│  └── AzureMonitorCollector                              │
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
| `app.ts` | AutoscaledService, WorkloadIdentityServiceAccount, ConfigMap |
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

## Resource counts

- **Azure lexicon**: ~14 ARM resources (VNet, subnets, NSG, route table, AKS cluster, ACR, managed identities, role assignments, DNS zone)
- **K8s lexicon**: ~20 Kubernetes resources (namespaces, quotas, limits, network policy, deployment, HPA, PDB, service, service accounts, ingress, storage class, DaemonSet, cluster roles, cluster role bindings, config maps)

## Cross-lexicon value flow

ARM template outputs map to K8s composite props via `.env`:

| ARM Output | K8s File | Composite Prop |
|------------|----------|----------------|
| `APP_CLIENT_ID` | `app.ts` | `WorkloadIdentityServiceAccount({ azureClientId })` |
| `EXTERNAL_DNS_CLIENT_ID` | `ingress.ts` | `AksExternalDnsAgent({ azureClientId })` |
| `MONITOR_CLIENT_ID` | `observability.ts` | `AzureMonitorCollector({ azureClientId })` |
| `AZURE_TENANT_ID` | multiple | `azureTenantId` props |
| `AKS_CLUSTER_NAME` | `observability.ts` | `clusterName` props |

Values flow through `.env` → `config.ts` → K8s source files. `npm run load-outputs` refreshes `.env` after any infra deploy.

## Security hardening

This example includes AKS best-practice hardening:

- **AKS Workload Identity** — pods authenticate to Azure APIs via OIDC federation, no static client secrets
- **Non-root container** — app runs `nginxinc/nginx-unprivileged` with `runAsNonRoot: true` on port 8080
- **Pod Security Standards** — namespace enforces `restricted` PSS profile (enforce, warn, audit)
- **Health probes** — liveness and readiness probes on the app container for proper rollout gating
- **Topology spread** — zone-based `topologySpreadConstraints` with `maxSkew: 1` prevents single-zone concentration
- **AKS built-in Metrics Server** — AKS ships its own metrics-server; HPA works out of the box without a custom deployment
- **Default-deny NetworkPolicy** — namespace-level network policy denies all ingress/egress by default
- **Resource quotas + LimitRange** — namespace-level resource quotas and per-container default limits prevent noisy neighbors
- **Managed identities with minimal roles** — each workload gets its own managed identity with least-privilege role assignments (ACR Pull, DNS Contributor, Monitoring Metrics Publisher)

## Prerequisites

- Azure CLI (`az`) logged in with an active subscription
- `kubectl` installed
- Subscription must have `Microsoft.ContainerService`, `Microsoft.Network`, `Microsoft.ManagedIdentity`, `Microsoft.ContainerRegistry`, and `Microsoft.Authorization` resource providers registered
- Minimum 6 vCPUs quota in your target region (3 × Standard_B2s nodes)

## Quick start (local verification)

```bash
cp .env.example .env
npm run build
npm run lint
```

## Deploy workflow

```bash
export AZURE_RESOURCE_GROUP=aks-microservice-rg
```

0. **Create resource group**: `az group create --name $AZURE_RESOURCE_GROUP --location eastus`
1. **Build**: `npm run build`
2. **Deploy infra**: `npm run deploy-infra`
3. **Configure kubectl**: `npm run configure-kubectl`
4. **Load outputs**: `npm run load-outputs`
5. **Rebuild K8s**: `npm run build:k8s`
6. **Apply workloads**: `npm run apply`
7. **Verify**: `npm run status`

Or run steps 1–7 in one shot: `npm run deploy`

## Teardown

```bash
npm run teardown
```

Deletes K8s workloads, then deletes the resource group (runs `az group delete --no-wait` in the background).

## Cost estimate

~$95/mo while running. Teardown after testing to avoid charges.

| Component | Cost |
|-----------|------|
| AKS control plane | Free (free tier) |
| Application Gateway | ~$20/mo |
| 3× Standard_B2s nodes | ~$75/mo |
| Azure DNS Zone | ~$0.50/mo |
| **Total** | **~$95/mo** |

## Testing

### Local build verification (no cloud account needed)
```bash
cp .env.example .env
npm run build
npm run lint
```

### Full E2E deployment
Follow the **Deploy workflow** section above. This deploys real cloud infrastructure.

### Docker smoke tests
`./test/smoke.sh smoke-aks` runs the same build inside a clean Docker container to verify the package installs correctly. This is a tooling test, not a substitute for E2E deployment.

## Related examples

- [k8s-gke-microservice](../k8s-gke-microservice/) — Same pattern on GCP GKE
- [k8s-eks-microservice](../k8s-eks-microservice/) — Same pattern on AWS EKS
- [cockroachdb-multi-region-gke](../cockroachdb-multi-region-gke/) — Multi-region stateful workload on GKE

## Standalone usage

Copy `package.standalone.json` to `package.json` and run `npm install`.
