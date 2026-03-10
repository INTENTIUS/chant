# CockroachDB Multi-Region on GKE

One CockroachDB cluster spanning **3 GCP regions** — 3 nodes per region, 9 nodes total.

Uses a single global VPC with native cross-region routing (~25-45ms). No VPN, no two-pass deploy, single IAM system. Chant's multi-stack layout: one project, subdirectories per region, each producing separate output stacks.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `npm install`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-gke` | `@intentius/chant-lexicon-gcp` | End-to-end GKE workflow: VPC, cluster, service accounts, K8s workloads |
| `chant-gcp` | `@intentius/chant-lexicon-gcp` | Config Connector lifecycle: build, lint, deploy, rollback |
| `chant-k8s` | `@intentius/chant-lexicon-k8s` | K8s operational playbook: composites, build, lint, apply, troubleshoot |
| `chant-k8s-gke` | `@intentius/chant-lexicon-k8s` | GKE-specific composites: Workload Identity, GCE ingress, PD, ExternalDNS |
| `chant-k8s-patterns` | `@intentius/chant-lexicon-k8s` | Advanced K8s patterns: sidecars, TLS, monitoring, network isolation |

> **Using Claude Code?** Ask your agent to deploy, passing your domain:
>
> ```
> Deploy the cockroachdb-multi-region-gke example. My domain is crdb.mycompany.com.
> ```
>
> Your agent will use `chant-gke` to walk through the full standup.

### Skills guide

This is a 2-lexicon, single-cloud multi-region example. Each deployment phase maps to specific skills.

#### `chant-gke` — primary entry point

The end-to-end GKE skill covers infrastructure provisioning and K8s workload deployment. Your agent invokes this skill to deploy all 3 regional clusters from a shared VPC:

- **Shared infra** — Global VPC, 6 subnets, Cloud NAT per region, Cloud DNS private zone
- **Regional infra** — GKE cluster, Workload Identity, ExternalDNS service accounts, public DNS zones
- **K8s workloads** — CockroachDB StatefulSets, namespaces, storage, ingress, ExternalDNS

#### `chant-k8s` — core composites and operations

Comprehensive reference for composites used across all 3 regions:

| Composite | Used in | What it does |
|-----------|---------|--------------|
| `CockroachDbCluster` | `*/k8s/cockroachdb.ts` | StatefulSet + headless/public Services + RBAC + PDB + init/cert Jobs |
| `NamespaceEnv` | `*/k8s/namespace.ts` | Namespace + ResourceQuota + LimitRange + PSS labels |

#### `chant-k8s-gke` — GKE-specific composites

| Composite | File | What it does |
|-----------|------|--------------|
| `GcePdStorageClass` | `*/k8s/storage.ts` | GCE PD CSI provisioner, pd-ssd |
| `GceIngress` | `*/k8s/ingress.ts` | GCE ingress class, static IP |
| `GkeExternalDnsAgent` | `*/k8s/ingress.ts` | Cloud DNS integration, Workload Identity |

#### `chant-gcp` — infra lifecycle

Config Connector lifecycle: build, validate, deploy, rollback.

#### `chant-k8s-patterns` — advanced patterns

Patterns to extend the workloads:

- **Sidecars** — Envoy proxy or log forwarder with `SidecarApp`
- **Config/Secret mounting** — `ConfiguredApp` for ConfigMap volumes and Secret env vars
- **TLS with cert-manager** — `SecureIngress` for additional ingress controllers
- **Prometheus monitoring** — `MonitoredService` with ServiceMonitor and alert rules

### Skill workflow

```
1. chant-gke                              "Deploy shared + regional infrastructure"
   │  (shared VPC, then 3 clusters)       → VPC, subnets, NAT, DNS, 3x GKE clusters
   │
2. chant-gcp                              "Config Connector lifecycle"
   │  (referenced by the above)           → validate, deploy, rollback
   │
3. chant-k8s                              "Deploy K8s workloads"
   │  (parallel — one per cluster)        → CockroachDbCluster, apply, verify
   │
4. chant-k8s-gke                          "Which composites do I need?"
   │  (GKE-specific composites)           → Workload Identity, GCE, storage, DNS
   │
5. chant-k8s-patterns                     "Extend with advanced patterns"
                                           → sidecars, monitoring, TLS, network isolation
```

### Agent-guided standup

Ask your agent to deploy and it will walk through these phases:

```
Deploy the cockroachdb-multi-region-gke example. My domain is crdb.mycompany.com.
```

Your agent will:

1. **Build** — `npm run build` generates 7 artifacts (1 shared infra + 3 regional infra + 3 K8s manifests)
2. **Deploy shared infra** — VPC, subnets, Cloud NAT, Cloud DNS private zone
3. **Deploy regional infra** — 3 GKE clusters + IAM + public DNS zones in parallel
4. **Configure kubectl** — sets up 3 kubectl contexts (east, central, west)
5. **Generate TLS certs** — `scripts/generate-certs.sh` creates a self-signed CA and node certs with SANs for all 9 nodes (both Cloud DNS and cluster-local names), distributes as K8s Secrets
6. **Deploy K8s workloads** — applies manifests in parallel across all 3 clusters (CockroachDB StatefulSets, ingress, ExternalDNS)
7. **Initialize cluster** — runs `cockroach init` to bootstrap the 9-node cluster
8. **Configure multi-region** — sets primary region, adds secondary regions, configures `SURVIVE REGION FAILURE`, creates demo `REGIONAL BY ROW` table
9. **Verify** — checks all pods are running and all 9 nodes are visible via `cockroach node status`

> **DNS delegation:** after step 3, your agent will prompt you to delegate `east.<domain>`, `central.<domain>`, and `west.<domain>` at your registrar. See [DNS Delegation](#dns-delegation-one-time-setup) below.

Other useful prompts:

```
Build and lint the cockroachdb-multi-region-gke example locally.
```

```
Tear down the cockroachdb-multi-region-gke example.
```

```
Check the status of all CockroachDB pods across all 3 regions.
```

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                    GCP VPC: crdb-multi-region                    │
│                                                                  │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐    │
│  │  GKE East    │     │  GKE Central │     │  GKE West    │    │
│  │  us-east4    │◄───►│  us-central1 │◄───►│  us-west1    │    │
│  │  10.1.0.0/20 │     │  10.2.0.0/20 │     │  10.3.0.0/20 │    │
│  │  crdb-east   │     │  crdb-central│     │  crdb-west   │    │
│  │  (3 nodes)   │     │  (3 nodes)   │     │  (3 nodes)   │    │
│  └──────────────┘     └──────────────┘     └──────────────┘    │
│              Native VPC routing (~25-45ms)                       │
└──────────────────────────────────────────────────────────────────┘

Cloud DNS private zone: crdb.internal
  cockroachdb-{0,1,2}.east.crdb.internal    → pod IPs (ExternalDNS)
  cockroachdb-{0,1,2}.central.crdb.internal → pod IPs (ExternalDNS)
  cockroachdb-{0,1,2}.west.crdb.internal    → pod IPs (ExternalDNS)
```

### Multi-region topology

CockroachDB's multi-region SQL features use locality metadata to optimize data placement:

- **`REGIONAL BY ROW`** — each row is assigned to a "home region" via the `crdb_internal_region` column. Reads from the home region are fast (local leaseholder); reads from other regions incur cross-region latency.
- **`SURVIVE REGION FAILURE`** — the cluster tolerates the loss of one entire region. CockroachDB maintains 5 replicas with majority quorum, ensuring data remains available when any one region goes down.
- **Locality flags** — each CockroachDB node starts with `--locality=cloud=gcp,region=us-east4` (or central/west). These flags must match the region names used in `ALTER DATABASE ... ADD REGION`.

The `scripts/configure-regions.sh` script sets up the topology after `cockroach init`:
1. Sets `gcp-us-east4` as the primary region
2. Adds `gcp-us-central1` and `gcp-us-west1`
3. Configures `SURVIVE REGION FAILURE`
4. Creates a demo `orders` table with `REGIONAL BY ROW` to demonstrate locality-aware reads/writes

## Prerequisites

- Google Cloud CLI configured (`gcloud auth login`)
- `kubectl` installed
- `docker` installed (for cert generation)
- A domain you control (set via `CRDB_DOMAIN` env var, e.g., `crdb.mycompany.com`)

### Required Environment Variables

Copy `.env.example` to `.env` and fill in the required values:

```bash
cp .env.example .env
# Edit .env with your values
set -a && source .env && set +a
```

| Env Var | Required | Description |
|---------|----------|-------------|
| `GCP_PROJECT_ID` | Yes | GCP project ID |
| `CRDB_DOMAIN` | Yes | Base domain for UI ingress (subdomains: `east.*`, `central.*`, `west.*`) |

## Local verification (no cloud accounts required)

Verify the example builds and lints locally before deploying:

```bash
cp .env.example .env
npm install
npm run build
npm run lint
```

This produces 7 output files in `dist/`:

```
dist/shared-infra.yaml     dist/east-infra.yaml    dist/east-k8s.yaml
                           dist/central-infra.yaml dist/central-k8s.yaml
                           dist/west-infra.yaml    dist/west-k8s.yaml
```

## DNS Delegation (One-Time Setup)

After Step 3 (regional infrastructure deploy), delegate each subdomain at your registrar.

### Get nameservers

```bash
# East
gcloud dns managed-zones describe crdb-east-zone \
  --project "${GCP_PROJECT_ID}" --format='value(nameServers)'

# Central
gcloud dns managed-zones describe crdb-central-zone \
  --project "${GCP_PROJECT_ID}" --format='value(nameServers)'

# West
gcloud dns managed-zones describe crdb-west-zone \
  --project "${GCP_PROJECT_ID}" --format='value(nameServers)'
```

### Create NS records at your registrar

```
east.<your-domain>     →  NS  (Cloud DNS zone nameservers)
central.<your-domain>  →  NS  (Cloud DNS zone nameservers)
west.<your-domain>     →  NS  (Cloud DNS zone nameservers)
```

### Verify

```bash
dig NS "east.${CRDB_DOMAIN}"
dig NS "central.${CRDB_DOMAIN}"
dig NS "west.${CRDB_DOMAIN}"
```

**Note:** The CockroachDB cluster works without DNS delegation (uses Cloud DNS private zone for inter-node communication). Public UI ingress won't resolve until delegation is complete.

## Deploy

```bash
cp .env.example .env
# Fill in required values in .env
set -a && source .env && set +a
npm install
npm run deploy
```

### Standalone usage

To run this example outside the monorepo, copy `package.standalone.json` to `package.json`:

```bash
cp package.standalone.json package.json
npm install
```

### What `npm run deploy` does

The deploy is a **true single-pass process** — no rebuild step needed. GCP VPC is global, so all regions share one VPC with native routing.

1. Builds all stacks (shared infra + regional infra + K8s for each region)
2. Deploys shared infrastructure (VPC, subnets, NAT, private DNS zone)
3. Deploys regional infrastructure in parallel (3 GKE clusters + IAM + public DNS zones)
4. Configures kubectl contexts (east, central, west)
5. Generates and distributes TLS certificates
6. Applies K8s manifests in parallel
7. Waits for ExternalDNS to register pod IPs in `crdb.internal`
8. Waits for StatefulSets to be ready
9. Runs `cockroach init`
10. Configures multi-region topology + creates demo table

## Verify

```bash
# Check all pods are running
kubectl --context east get pods -n crdb-east
kubectl --context central get pods -n crdb-central
kubectl --context west get pods -n crdb-west

# Check CockroachDB cluster status (should show all 9 nodes)
kubectl --context east exec cockroachdb-0 -n crdb-east -- \
  /cockroach/cockroach node status --certs-dir=/cockroach/cockroach-certs

# Check multi-region topology
kubectl --context east exec cockroachdb-0 -n crdb-east -- \
  /cockroach/cockroach sql --certs-dir=/cockroach/cockroach-certs \
  -e "SHOW REGIONS FROM DATABASE defaultdb;"

# Query demo table (rows from all 3 regions)
kubectl --context east exec cockroachdb-0 -n crdb-east -- \
  /cockroach/cockroach sql --certs-dir=/cockroach/cockroach-certs \
  -e "SELECT region, id, total FROM orders;"

# Connect via SQL
kubectl --context east exec -it cockroachdb-0 -n crdb-east -- \
  /cockroach/cockroach sql --certs-dir=/cockroach/cockroach-certs
```

## Teardown

```bash
npm run teardown
```

## Cost Estimate

~$1.80/hr (~$43/day) total. Teardown after testing to avoid charges.

| Component | Per Region | 3 Regions |
|-----------|-----------|-----------|
| GKE control plane | $0.10/hr | $0.30/hr |
| 3x e2-standard-4 nodes | ~$0.40/hr | ~$1.20/hr |
| Storage (3x 100Gi pd-ssd) | ~$0.05/hr | ~$0.15/hr |
| Cloud NAT | ~$0.05/hr | ~$0.15/hr |

No VPN gateway costs — GCP VPC routes natively between regions.

## Project Structure

```
src/
├── shared/
│   ├── chant.config.json
│   ├── config.ts              # CIDRs, join addresses, CRDB version, regions
│   └── infra/
│       ├── networking.ts      # VPC + 6 subnets + firewall + 3 NATs
│       └── dns.ts             # Cloud DNS private zone (crdb.internal)
├── east/
│   ├── chant.config.json
│   ├── config.ts              # us-east4 config
│   ├── infra/
│   │   ├── cluster.ts         # GKE cluster + Workload Identity + IAM
│   │   └── dns.ts             # Cloud DNS public zone (east.<domain>)
│   └── k8s/
│       ├── namespace.ts       # NamespaceEnv + NetworkPolicy
│       ├── storage.ts         # GcePdStorageClass (pd-ssd)
│       ├── cockroachdb.ts     # CockroachDbCluster composite
│       └── ingress.ts         # GceIngress + GkeExternalDnsAgent
├── central/                   # Same structure as east/
└── west/                      # Same structure as east/
scripts/
├── deploy.sh                  # Single-pass deploy orchestrator
├── teardown.sh                # Full teardown
├── generate-certs.sh          # TLS cert generation + distribution
└── configure-regions.sh       # Multi-region SQL setup + demo table
```

## Source files

### Shared

| File | What it defines |
|------|-----------------|
| `src/shared/config.ts` | Cluster-wide constants: per-region CIDRs (10.1/2/3.0.0/20), Cloud DNS join addresses for all 9 nodes, CockroachDB version (v24.3.0), project ID |
| `src/shared/infra/networking.ts` | VpcNetwork (global VPC, 6 subnets: nodes + pods per region, Cloud NAT for us-east4), Router + RouterNAT for us-central1 and us-west1 |
| `src/shared/infra/dns.ts` | Cloud DNS private zone (`crdb.internal`) visible to all 3 clusters via shared VPC |

### East (us-east4)

**Infrastructure** (`src/east/infra/` → `dist/east-infra.yaml`)

| File | Resources |
|------|-----------|
| `src/east/config.ts` | East-specific config (cluster name, region, namespace, locality) |
| `src/east/infra/cluster.ts` | GKE cluster (3x e2-standard-4), GCP ServiceAccount, 2x IAMPolicyMember (workload identity + DNS admin) |
| `src/east/infra/dns.ts` | Cloud DNS public zone (`east.<domain>`) |

**Kubernetes** (`src/east/k8s/` → `dist/east-k8s.yaml`)

| File | Resources |
|------|-----------|
| `src/east/k8s/namespace.ts` | NamespaceEnv (crdb-east), ResourceQuota (8 CPU / 32Gi), LimitRange, 2x NetworkPolicy (default-deny + CRDB cross-region allow) |
| `src/east/k8s/storage.ts` | GcePdStorageClass (pd-ssd) |
| `src/east/k8s/cockroachdb.ts` | CockroachDbCluster composite: StatefulSet (3 replicas), Services (headless annotated for ExternalDNS), RBAC, PDB, init + cert jobs |
| `src/east/k8s/ingress.ts` | GceIngress (CockroachDB UI), GkeExternalDnsAgent (Cloud DNS records for public + private zones) |

### Central (us-central1)

Same structure as East — `src/central/` → `dist/central-infra.yaml` + `dist/central-k8s.yaml`

### West (us-west1)

Same structure as East — `src/west/` → `dist/west-infra.yaml` + `dist/west-k8s.yaml`

## Resource counts

| Stack | Lexicon | Approximate resources |
|-------|---------|-----------------------|
| Shared infra | GCP (Config Connector) | ~12 |
| East infra | GCP (Config Connector) | ~7 |
| East K8s | K8s | ~18 |
| Central infra | GCP (Config Connector) | ~7 |
| Central K8s | K8s | ~18 |
| West infra | GCP (Config Connector) | ~7 |
| West K8s | K8s | ~18 |
| **Total** | | **~87** |

## Cross-region value flow

Only 2 required environment variables — GCP's global VPC eliminates the need for cross-cloud coordination.

| Env Var | Source | Consumed by |
|---------|--------|-------------|
| `GCP_PROJECT_ID` | User | All `config.ts` files — GCP project scope, IAM bindings, Workload Identity |
| `CRDB_DOMAIN` | User | All `config.ts` files — base domain for DNS zones and ingress |

### Data flow diagram

```
.env (user)  ──►  shared/config.ts  ──►  shared/infra/*.ts  ──►  dist/shared-infra.yaml
                        │
                        ├──►  east/config.ts    ──►  east/infra/*.ts + east/k8s/*.ts
                        ├──►  central/config.ts ──►  central/infra/*.ts + central/k8s/*.ts
                        └──►  west/config.ts    ──►  west/infra/*.ts + west/k8s/*.ts
```

No two-pass build — all values are known at build time.

## TLS Strategy

- **Inter-node + client:** Self-signed CA via `cockroach cert` (generated locally, distributed as K8s Secrets). One node cert with SANs for all 9 nodes across all 3 clusters — includes both Cloud DNS names (`*.{region}.crdb.internal`) and cluster-local names.
- **Dashboard UI:** Public Ingress on `{region}.<CRDB_DOMAIN>` via GCE Ingress.
- **Multi-region cert generation:** Uses `scripts/generate-certs.sh` (external). The K8s composite's built-in cert-gen Job is for single-cluster deployments only.

## Security hardening

1. **Pod Security Standards** — all namespaces enforce `baseline` with `restricted` warn/audit, blocking privileged containers
2. **Default-deny NetworkPolicy** — each namespace starts with deny-all ingress; a second policy explicitly allows CockroachDB ports (26257 gRPC, 8080 HTTP) only from the 6 regional CIDRs (3 node + 3 pod subnets)
3. **Cloud DNS private zone** — inter-node discovery uses a private DNS zone visible only within the VPC; no public DNS exposure of pod IPs
4. **Encrypted inter-node traffic** — CockroachDB TLS with self-signed CA; all node-to-node and client-to-node traffic is mTLS
5. **Encrypted storage** — GCP pd-ssd (encrypted at rest by default)
6. **Native VPC routing** — cross-region traffic stays on Google's private network backbone; never traverses the public internet
7. **Workload Identity** — Workload Identity Federation on GKE; no long-lived credentials in K8s
8. **Resource quotas + LimitRange** — each namespace caps at 8 CPU / 32Gi memory with per-pod defaults and limits
9. **Non-root containers** — CockroachDB runs as non-root (UID 1000) with read-only root filesystem where supported
10. **PodDisruptionBudget** — ensures at least 2 of 3 pods per region remain available during node maintenance

## Testing

### Local build verification

```bash
cp .env.example .env
npm install
npm run build    # produces 7 artifacts in dist/
npm run lint     # runs chant lint on all 4 stacks
```

### Full E2E deployment

```bash
# Fill in .env with real credentials
npm run deploy   # single-pass deploy across 3 GCP regions
# Verify (see Verify section above)
npm run teardown
```

### Docker smoke tests

The repo-level smoke tests (`test/smoke.sh`) verify packages install and build in a clean Docker environment. They are **not** for E2E validation — use `npm run deploy` for that.

## Related examples

- **[k8s-gke-microservice](../k8s-gke-microservice/)** — single-cloud GKE with GCE ingress and workload identity
- **[k8s-eks-microservice](../k8s-eks-microservice/)** — single-cloud EKS with ALB ingress, IRSA, and observability
- **[k8s-aks-microservice](../k8s-aks-microservice/)** — single-cloud AKS with AGIC ingress and workload identity
- **[gcp-gitlab-cells](../gcp-gitlab-cells/)** — multi-cell GitLab on GKE with Cloud SQL, Redis, and GCS
