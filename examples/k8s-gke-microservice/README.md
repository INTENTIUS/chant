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
│  ├── GCE Ingress + GkeExternalDnsAgent                  │
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
| `ingress.ts` | GCE Ingress, GkeExternalDnsAgent |
| `storage.ts` | GcePdStorageClass |
| `observability.ts` | GkeFluentBitAgent, GkeOtelCollector |

## Prerequisites

- **gcloud CLI** — authenticated with a project that has billing enabled
- **kubectl** — installed and on PATH
- **bun** — for building chant sources

## Quick start (local verification)

```bash
cp .env.example .env
npm run build
npm run lint
```

## Deploy workflow

### 0. Bootstrap (one-time)

Creates a GKE cluster with Config Connector enabled and configures Workload Identity:

```bash
export GCP_PROJECT_ID=<your-project>
npm run bootstrap
```

This enables required APIs, creates the cluster, sets up a Config Connector service account with editor/IAM/DNS roles, and waits for the controller to be ready.

### 1–7. Deploy

```bash
npm run deploy
```

This runs the full pipeline: build → deploy Config Connector resources → get cluster credentials → load outputs → rebuild K8s manifests → apply workloads → wait → status.

Individual steps:

1. **Build**: `npm run build`
2. **Deploy infra**: `npm run deploy-infra` (applies Config Connector resources)
3. **Configure kubectl**: `npm run configure-kubectl`
4. **Load outputs**: `npm run load-outputs`
5. **Rebuild K8s**: `npm run build:k8s`
6. **Apply workloads**: `npm run apply`
7. **Verify**: `npm run status`

### Teardown

```bash
npm run teardown
```

Deletes resources in the correct order: K8s workloads first (drains load balancers), then Config Connector resources (deletes GCP infra), then the Config Connector service account, and finally the GKE cluster itself.

## Skills guide

The lexicon packages (`@intentius/chant-lexicon-gcp` and `@intentius/chant-lexicon-k8s`) ship four skills that guide your agent through every aspect of this example. After `chant init --lexicon gcp` and `chant init --lexicon k8s`, your agent has access to:

### `chant-gke` — primary entry point

The **`chant-gke`** skill (GCP lexicon) covers the full end-to-end workflow:

- Bootstrapping a GKE cluster with Config Connector
- Deploying Config Connector resources and K8s workloads
- Cross-lexicon value mapping: which CC output feeds which K8s composite prop
- Scaffolding new projects with `chant init --lexicon gcp --template gke`

### `chant-k8s-gke` — GKE-specific composites

Covers the composites used in `src/k8s/`:

| Composite | File | What it does |
|-----------|------|--------------|
| `WorkloadIdentityServiceAccount` | `app.ts` | GKE WI setup, `iam.gke.io/gcp-service-account` annotation |
| `GkeExternalDnsAgent` | `ingress.ts` | Cloud DNS integration, Workload Identity |
| `GcePdStorageClass` | `storage.ts` | GCE PD CSI provisioner, pd-balanced |
| `GkeFluentBitAgent` | `observability.ts` | DaemonSet config, Cloud Logging output |
| `GkeOtelCollector` | `observability.ts` | DaemonSet config, Cloud Trace + Monitoring pipeline |

### `chant-k8s` — core composites reference

Comprehensive reference for all 20 composites:

- **"Choosing the Right Composite" decision tree** — which composite for each workload type
- Hardening options: `minAvailable` (PDB), `initContainers`, `securityContext`, `priorityClassName`
- Build/lint/apply workflow and troubleshooting

### `chant-k8s-patterns` — advanced patterns

Patterns to add next:

- **Sidecars** — Envoy proxy or log forwarder with `SidecarApp`
- **Config/Secret mounting** — `ConfiguredApp` for ConfigMap volumes and Secret env vars
- **TLS with cert-manager** — `SecureIngress` for non-GCP ingress controllers
- **Prometheus monitoring** — `MonitoredService` with ServiceMonitor and alert rules

### Skill workflow

```
1. chant-gke           "Deploy a GKE project end-to-end"
   │                   → Scaffold, bootstrap, deploy CC resources + workloads
   │
2. chant-k8s-gke       "Which GKE composites do I need?"
   │                   → WI, Gateway, PD, Filestore, FluentBit, OTel, ExternalDNS
   │
3. chant-k8s           "How do I choose between composites?"
   │                   → Decision tree, hardening options, troubleshooting
   │
4. chant-k8s-patterns  "What patterns can I add next?"
                       → Sidecars, monitoring, TLS, network isolation
```

## Resource counts

- **GCP lexicon**: ~15 Config Connector resources (VPC, subnets, NAT, GKE cluster, node pool, service accounts, IAM bindings, DNS zone)
- **K8s lexicon**: ~12 Kubernetes resources (namespace, quotas, deployment, HPA, PDB, ingress, storage class, DaemonSets, collectors)

## Standalone usage

Copy `package.standalone.json` to `package.json` and run `npm install`.
