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
│  ├── GceIngress + GkeExternalDnsAgent                   │
│  ├── GcePdStorageClass                                  │
│  ├── GkeFluentBitAgent (Cloud Logging)                  │
│  └── GkeOtelCollector (Cloud Trace + Monitoring)        │
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
| `app.ts` | AutoscaledService, WorkloadIdentityServiceAccount, ConfigMap |
| `ingress.ts` | GceIngress, GkeExternalDnsAgent |
| `storage.ts` | GcePdStorageClass |
| `observability.ts` | GkeFluentBitAgent, GkeOtelCollector |

## Prerequisites

- **gcloud CLI** — authenticated with a project that has billing enabled
- **kubectl** — installed and on PATH
- **Node.js 20+** — for building chant sources

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

## Spell

This example has a corresponding spell for AI-driven deployment:

```bash
chant spell cast gke-bootstrap
```

## Resource counts

- **GCP lexicon**: ~15 Config Connector resources (VPC, subnets, NAT, GKE cluster, node pool, service accounts, IAM bindings, DNS zone)
- **K8s lexicon**: ~20 Kubernetes resources (namespaces, quotas, limits, network policy, deployment, HPA, PDB, service, service accounts, ingress, storage class, DaemonSets, cluster roles, cluster role bindings, config maps)

## Cross-lexicon value flow

Config Connector resource outputs map to K8s composite props via `.env`:

| CC Output | K8s File | Composite Prop |
|-----------|----------|----------------|
| `APP_GSA_EMAIL` | `app.ts` | `WorkloadIdentityServiceAccount({ gcpServiceAccountEmail })` |
| `EXTERNAL_DNS_GSA_EMAIL` | `ingress.ts` | `GkeExternalDnsAgent({ gcpServiceAccountEmail })` |
| `FLUENT_BIT_GSA_EMAIL` | `observability.ts` | `GkeFluentBitAgent({ gcpServiceAccountEmail })` |
| `OTEL_GSA_EMAIL` | `observability.ts` | `GkeOtelCollector({ gcpServiceAccountEmail })` |
| `GCP_PROJECT_ID` | multiple | `gcpProjectId` / `projectId` props |
| `GKE_CLUSTER_NAME` | `observability.ts` | `clusterName` props |

Values flow through `.env` → `config.ts` → K8s source files. `npm run load-outputs` refreshes `.env` after any infra deploy.

## Security hardening

This example includes GKE best-practice hardening:

- **Workload Identity** — pods authenticate to GCP APIs via Kubernetes service account annotations, no long-lived JSON key credentials
- **Non-root container** — app runs `nginxinc/nginx-unprivileged` with `runAsNonRoot: true` on port 8080
- **Pod Security Standards** — namespace enforces `restricted` PSS profile (enforce, warn, audit)
- **Health probes** — liveness and readiness probes on the app container for proper rollout gating
- **Topology spread** — zone-based `topologySpreadConstraints` with `maxSkew: 1` prevents single-zone concentration
- **GKE built-in Metrics Server** — GKE ships its own metrics-server; HPA works out of the box without a custom deployment
- **Default-deny NetworkPolicy** — namespace-level network policy denies all ingress/egress by default
- **Resource quotas + LimitRange** — namespace-level resource quotas and per-container default limits prevent noisy neighbors
- **Config Connector SA scoping** — Config Connector service account uses minimal IAM roles (editor, IAM admin, DNS admin)

## Cost estimate

~$107/mo while running. Teardown after testing to avoid charges.

| Component | Cost |
|-----------|------|
| GKE control plane | Free (one zonal cluster) |
| 3× e2-medium nodes | ~$75/mo |
| Cloud NAT | ~$32/mo |
| Cloud DNS ManagedZone | ~$0.20/mo |
| **Total** | **~$107/mo** |

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
`./test/smoke.sh smoke-gke` runs the same build inside a clean Docker container to verify the package installs correctly. This is a tooling test, not a substitute for E2E deployment.

## Related examples

- [k8s-eks-microservice](../k8s-eks-microservice/) — Same pattern on AWS EKS
- [k8s-aks-microservice](../k8s-aks-microservice/) — Same pattern on Azure AKS
- [cockroachdb-multi-region-gke](../cockroachdb-multi-region-gke/) — Multi-region stateful workload on GKE

## Standalone usage

Copy `package.standalone.json` to `package.json` and run `npm install`.
