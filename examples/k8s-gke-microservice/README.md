# k8s-gke-microservice

Production-grade GKE microservice with cross-lexicon builds — GCP infrastructure via Config Connector + Kubernetes workloads.

## What it builds

```
chant build src --lexicon gcp  → config.yaml   (Config Connector YAML)
chant build src --lexicon k8s  → k8s.yaml      (K8s workload YAML)
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  GCP Lexicon (Config Connector)                         │
│  ├── VPC + Subnets + Cloud NAT                          │
│  ├── GKE Cluster + Node Pool (Workload Identity)        │
│  ├── 4× GCP Service Accounts                           │
│  ├── IAM Policy Members (WI bindings + role grants)     │
│  └── Cloud DNS Managed Zone                             │
└────────────────────┬────────────────────────────────────┘
                     │ SA emails via .env → config.ts
┌────────────────────▼────────────────────────────────────┐
│  K8s Lexicon                                            │
│  ├── Namespace (quotas, limits, network policy)         │
│  ├── AutoscaledService (Deployment + HPA + PDB)         │
│  ├── WorkloadIdentityServiceAccount (GKE)               │
│  ├── GKE Gateway + GkeExternalDnsAgent                  │
│  ├── GcePdStorageClass                                  │
│  ├── GkeFluentBitAgent (Cloud Logging)                  │
│  ├── GkeOtelCollector (Cloud Trace + Monitoring)        │
│  └── MetricsServer                                      │
└─────────────────────────────────────────────────────────┘
```

## Source files

### `src/infra/` — GCP resources (Config Connector)

| File | Resources |
|------|-----------|
| `networking.ts` | VPC, 2 subnets, firewall rules, Cloud Router, Cloud NAT |
| `cluster.ts` | GKE cluster, node pool, 4 GCP SAs, IAM bindings |
| `dns.ts` | Cloud DNS ManagedZone |

### `src/k8s/` — Kubernetes workloads

| File | Resources |
|------|-----------|
| `namespace.ts` | Namespace, ResourceQuota, LimitRange, NetworkPolicy |
| `app.ts` | AutoscaledService, WorkloadIdentityServiceAccount, ConfigMap, MetricsServer |
| `ingress.ts` | GKE Gateway, GkeExternalDnsAgent |
| `storage.ts` | GcePdStorageClass |
| `observability.ts` | GkeFluentBitAgent, GkeOtelCollector |

## Quick start (local verification)

```bash
cp .env.example .env
npm run build
npm run lint
```

## Deploy workflow

1. **Build**: `npm run build`
2. **Deploy infra**: `npm run deploy-infra` (requires Config Connector on management cluster)
3. **Configure kubectl**: `npm run configure-kubectl`
4. **Load outputs**: `npm run load-outputs`
5. **Rebuild K8s**: `npm run build:k8s`
6. **Apply workloads**: `npm run apply`
7. **Verify**: `npm run status`

## Standalone usage

Copy `package.standalone.json` to `package.json` and run `npm install`.
