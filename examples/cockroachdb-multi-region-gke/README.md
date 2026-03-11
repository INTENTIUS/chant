# CockroachDB Multi-Region on GKE

One CockroachDB cluster spanning **3 GCP regions** — 3 nodes per region, 9 nodes total.

Uses a single global VPC with native cross-region routing (~25-45ms). No VPN, no two-pass deploy, single IAM system. A **management cluster** with Config Connector creates all GCP infra via `kubectl apply`, then K8s manifests are applied to the 3 workload clusters. Chant's multi-stack layout: one project, subdirectories per region, each producing separate output stacks.

## Agent walkthrough

The lexicon packages (`@intentius/chant-lexicon-gcp` and `@intentius/chant-lexicon-k8s`) ship operational playbooks called **skills**. After `npm install`, your agent loads them automatically. This example uses 5 skills — `chant-gke` (the primary entry point), `chant-gcp`, `chant-k8s`, `chant-k8s-gke`, and `chant-k8s-patterns` — to deploy a 9-node CockroachDB cluster across 3 GCP regions.

Kick things off with a single prompt:

```
Deploy the cockroachdb-multi-region-gke example.
My domain is crdb.mycompany.com. My GCP project is my-project-id.
```

The agent loads the relevant skills and walks through 11 phases.

### Phase-by-phase walkthrough

#### Phase 0 — Bootstrap management cluster

Creates a GKE management cluster in us-central1 with Config Connector (installed via operator bundle). Config Connector runs on this cluster and manages all GCP infrastructure (VPC, workload GKE clusters, IAM, DNS) declaratively via `kubectl apply`. **Skill:** `chant-gke`.

```bash
npm run bootstrap
```

This creates the `gke-crdb-mgmt` cluster, a Config Connector service account with editor/IAM/DNS roles, and waits for the CC controller to be ready.

> **Note:** You only need to run bootstrap once. Subsequent deploys reuse the management cluster.

#### Phase 1 — Build all stacks

The agent builds 7 output artifacts (1 shared infra + 3 regional infra + 3 K8s manifests). **Skills:** `chant-gcp`, `chant-k8s`.

```bash
npm run build
```

You see 7 files appear in `dist/`.

#### Phase 2 — Deploy shared infra

Creates the global VPC, 6 subnets, Cloud NAT per region, and the Cloud DNS private zone (`crdb.internal`) via Config Connector on the management cluster. **Skill:** `chant-gcp`.

```bash
kubectl apply -f dist/shared-infra.yaml
```

#### Phase 3 — Deploy regional infra

Applies 3 GKE cluster definitions, IAM service accounts, Workload Identity bindings, and public DNS zones via Config Connector, then waits for the clusters to be Ready. **Skill:** `chant-gke`.

```bash
kubectl apply -f dist/east-infra.yaml
kubectl apply -f dist/central-infra.yaml
kubectl apply -f dist/west-infra.yaml

# Wait for Config Connector to reconcile all 3 clusters
kubectl wait --for=condition=Ready containercluster/gke-crdb-east --timeout=600s
kubectl wait --for=condition=Ready containercluster/gke-crdb-central --timeout=600s
kubectl wait --for=condition=Ready containercluster/gke-crdb-west --timeout=600s
```

#### Phase 4 — DNS delegation

> **This is the one manual step.** The agent can't create records at your registrar, so it pauses and shows you the nameservers for each regional zone.

The agent runs:

```bash
gcloud dns managed-zones describe crdb-east-zone \
  --project "${GCP_PROJECT_ID}" --format='value(nameServers)'
gcloud dns managed-zones describe crdb-central-zone \
  --project "${GCP_PROJECT_ID}" --format='value(nameServers)'
gcloud dns managed-zones describe crdb-west-zone \
  --project "${GCP_PROJECT_ID}" --format='value(nameServers)'
```

**What you do:** Create NS records at your registrar pointing `east.<domain>`, `central.<domain>`, and `west.<domain>` to the nameservers shown. See [DNS Delegation](#dns-delegation-one-time-setup) for details.

Verify with:

```bash
dig NS "east.${CRDB_DOMAIN}"
dig NS "central.${CRDB_DOMAIN}"
dig NS "west.${CRDB_DOMAIN}"
```

> **Note:** The CockroachDB cluster works without DNS delegation (inter-node communication uses the private DNS zone). Public UI ingress won't resolve until delegation is complete.

#### Phase 5 — Configure kubectl contexts

Fetches credentials for all 3 clusters and renames contexts to `east`, `central`, `west`. **Skill:** `chant-gke`.

```bash
gcloud container clusters get-credentials gke-crdb-east --region us-east4 --project "${GCP_PROJECT_ID}"
kubectl config rename-context "$(kubectl config current-context)" east

gcloud container clusters get-credentials gke-crdb-central --region us-central1 --project "${GCP_PROJECT_ID}"
kubectl config rename-context "$(kubectl config current-context)" central

gcloud container clusters get-credentials gke-crdb-west --region us-west1 --project "${GCP_PROJECT_ID}"
kubectl config rename-context "$(kubectl config current-context)" west
```

#### Phase 6 — Generate TLS certs

Runs `scripts/generate-certs.sh` to create a self-signed CA and node certs with SANs for all 9 nodes (both Cloud DNS and cluster-local names), then distributes them as K8s Secrets. **Skill:** `chant-k8s-patterns`.

```bash
bash scripts/generate-certs.sh
```

#### Phase 7 — Deploy K8s manifests (parallel)

Applies CockroachDB StatefulSets, namespaces, storage, ingress, and ExternalDNS across all 3 clusters in parallel. **Skills:** `chant-k8s`, `chant-k8s-gke`.

```bash
kubectl --context east apply -f dist/east-k8s.yaml &
kubectl --context central apply -f dist/central-k8s.yaml &
kubectl --context west apply -f dist/west-k8s.yaml &
wait
```

#### Phase 8 — Wait for ExternalDNS + StatefulSets

The agent waits for ExternalDNS to register pod IPs in the `crdb.internal` private zone, then waits for all 3 StatefulSets to become ready. **Skill:** `chant-k8s`.

```bash
for ctx in east central west; do
  kubectl --context "${ctx}" -n kube-system rollout status deployment/external-dns --timeout=120s
done

kubectl --context east -n crdb-east rollout status statefulset/cockroachdb --timeout=300s
kubectl --context central -n crdb-central rollout status statefulset/cockroachdb --timeout=300s
kubectl --context west -n crdb-west rollout status statefulset/cockroachdb --timeout=300s
```

> **Troubleshooting:** If ExternalDNS logs show `googleapi: Error 403: Forbidden`, the Workload Identity binding is missing or the project ID is wrong. Check with: `kubectl --context east -n kube-system describe sa external-dns-sa | grep iam.gke.io`

#### Phase 9 — Initialize CockroachDB

Bootstraps the 9-node cluster with `cockroach init`. **Skill:** `chant-k8s`.

```bash
kubectl --context east exec cockroachdb-0 -n crdb-east -- \
  /cockroach/cockroach init --certs-dir=/cockroach/cockroach-certs
```

#### Phase 10 — Configure multi-region topology

Sets the primary region, adds secondary regions, configures `SURVIVE REGION FAILURE`, and creates a demo `REGIONAL BY ROW` table. **Skill:** `chant-gke`.

```bash
bash scripts/configure-regions.sh
```

You see output confirming all 3 regions are configured and the demo `orders` table is created.

### After deployment

Follow-up prompts you can give your agent:

```
Check the status of all CockroachDB pods across all 3 regions.
```

```
Tear down the cockroachdb-multi-region-gke example.
```

```
Build and lint the cockroachdb-multi-region-gke example locally.
```

### Skills reference

<details>
<summary>5 skills used in this example</summary>

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-gke` | `@intentius/chant-lexicon-gcp` | End-to-end GKE workflow: VPC, cluster, service accounts, K8s workloads |
| `chant-gcp` | `@intentius/chant-lexicon-gcp` | Config Connector lifecycle: build, lint, deploy, rollback |
| `chant-k8s` | `@intentius/chant-lexicon-k8s` | K8s operational playbook: composites, build, lint, apply, troubleshoot |
| `chant-k8s-gke` | `@intentius/chant-lexicon-k8s` | GKE-specific composites: Workload Identity, GCE ingress, PD, ExternalDNS |
| `chant-k8s-patterns` | `@intentius/chant-lexicon-k8s` | Advanced K8s patterns: sidecars, TLS, monitoring, network isolation |

</details>

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
│  │  Prometheus  │     │  Prometheus  │     │  Prometheus  │    │
│  └──────┬───────┘     └──────┬───────┘     └──────┬───────┘    │
│         │                    │                    │              │
│         └────────────────────┴────────────────────┘              │
│              Native VPC routing (~25-45ms)                       │
│                                                                  │
│  Cloud Armor (crdb-ui-waf) ── WAF + rate limiting + DDoS        │
│  KMS (crdb-encryption) ────── encryption at rest (90d rotation) │
│  GCS (crdb-backups) ───────── daily backups with lifecycle      │
│  Secret Manager ───────────── TLS certs → ESO → K8s Secrets     │
└──────────────────────────────────────────────────────────────────┘

Cloud DNS private zone: crdb.internal
  cockroachdb-{0,1,2}.east.crdb.internal    → pod IPs (ExternalDNS)
  cockroachdb-{0,1,2}.central.crdb.internal → pod IPs (ExternalDNS)
  cockroachdb-{0,1,2}.west.crdb.internal    → pod IPs (ExternalDNS)
```

### Cross-cluster discovery with ExternalDNS

Each GKE cluster runs its own kube-dns, which only resolves `*.svc.cluster.local` names within that cluster. CockroachDB needs all 9 nodes to find each other across 3 separate clusters.

**Solution:** A Cloud DNS private zone (`crdb.internal`) shared across all 3 clusters via the global VPC. ExternalDNS in each cluster watches the CockroachDB headless service and registers pod IPs as A records:

```
ExternalDNS (east cluster)
  watches: headless Service annotated with external-dns.alpha.kubernetes.io/hostname=east.crdb.internal
  creates: cockroachdb-0.east.crdb.internal → 10.1.x.x (pod IP)
           cockroachdb-1.east.crdb.internal → 10.1.x.y
           cockroachdb-2.east.crdb.internal → 10.1.x.z

ExternalDNS (central cluster)  →  cockroachdb-{0,1,2}.central.crdb.internal
ExternalDNS (west cluster)     →  cockroachdb-{0,1,2}.west.crdb.internal
```

CockroachDB's `--join` flag references these Cloud DNS names. When pods restart and get new IPs, ExternalDNS updates the records automatically.

ExternalDNS also manages **public DNS records** for the CockroachDB UI ingress (`east.<domain>`, `central.<domain>`, `west.<domain>`) via per-region public Cloud DNS zones.

**Workload Identity chain:** Each ExternalDNS pod authenticates to Cloud DNS without long-lived keys:

```
GCP ServiceAccount (gke-crdb-{region}-dns)
  └── IAMPolicyMember: roles/dns.admin (can manage DNS records)
  └── IAMPolicyMember: roles/iam.workloadIdentityUser
        └── binds to K8s SA "external-dns-sa" in kube-system namespace
              └── ExternalDNS Deployment runs as this K8s SA
```

### Multi-region topology

CockroachDB's multi-region SQL features use locality metadata to optimize data placement:

- **`REGIONAL BY ROW`** — each row is assigned to a "home region" via the `crdb_internal_region` column. Reads from the home region are fast (local leaseholder); reads from other regions incur cross-region latency.
- **`SURVIVE REGION FAILURE`** — the cluster tolerates the loss of one entire region. CockroachDB maintains 5 replicas with majority quorum, ensuring data remains available when any one region goes down.
- **Locality flags** — each CockroachDB node starts with `--locality=cloud=gcp,region=us-east4` (or central/west). These flags must match the region names used in `ALTER DATABASE ... ADD REGION`.

The `scripts/configure-regions.sh` script sets up the topology after `cockroach init`:
1. Sets `us-east4` as the primary region
2. Adds `us-central1` and `us-west1`
3. Configures `SURVIVE REGION FAILURE`
4. Creates a demo `orders` table with `REGIONAL BY ROW` to demonstrate locality-aware reads/writes

## Prerequisites

### GCP Quota

Config Connector creates GKE clusters with a default node pool (3 nodes × 2 vCPU) that can't be suppressed. The managed node pool (3 × e2-standard-4 = 12 vCPU) is created in parallel. Peak vCPU usage per region is 18 (6 default + 12 managed). With the management cluster (6 vCPU) and 3 regions: **6 + 3×18 = 60 vCPU peak**. After default pools are deleted, steady-state is 6 + 3×12 = 42 vCPU.

Ensure your `CPUS_ALL_REGIONS` quota is at least **64** (with headroom). Check with:

```bash
gcloud compute regions list --project "${GCP_PROJECT_ID}" \
  --format="table(name, quotas.filter('metric:CPUS').map().extract('limit','usage').flatten())"
```

### Tools

- Google Cloud CLI configured (`gcloud auth login`)
- `kubectl` installed
- `docker` installed (for cert generation)
- `helm` installed (for External Secrets Operator)
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
npm run bootstrap   # one-time: creates management cluster with Config Connector
npm run deploy
```

### Standalone usage

To run this example outside the monorepo, copy `package.standalone.json` to `package.json`:

```bash
cp package.standalone.json package.json
npm install
```

### What `npm run deploy` does

The deploy is a **true single-pass process** — no rebuild step needed. GCP VPC is global, so all regions share one VPC with native routing. All GCP infra is created via Config Connector on the management cluster (see `npm run bootstrap`).

1. Builds all stacks (shared infra + regional infra + K8s for each region)
2. `kubectl apply` shared infra to management cluster (Config Connector creates VPC, subnets, NAT, private DNS zone, KMS, GCS bucket, Secret Manager, Cloud Armor, IAM)
3. `kubectl apply` regional infra (Config Connector creates 3 GKE clusters + zone-scoped IAM + public DNS zones), waits for clusters to be Ready
4. Configures kubectl contexts for workload clusters (east, central, west)
5. Generates and distributes TLS certificates
5b. Installs External Secrets Operator on all 3 workload clusters via Helm
5c. Pushes TLS certificates to Secret Manager
6. Applies K8s manifests to workload clusters in parallel (includes ESO, BackendConfig, Prometheus)
7. Waits for ExternalDNS to register pod IPs in `crdb.internal`
8. Waits for StatefulSets to be ready
9. Runs `cockroach init`
10. Configures multi-region topology + creates demo table
11. Creates daily backup schedule to GCS

## Verify

### Pods and cluster status

```bash
# Check all pods are running
kubectl --context east get pods -n crdb-east
kubectl --context central get pods -n crdb-central
kubectl --context west get pods -n crdb-west

# Check CockroachDB cluster status (should show all 9 nodes)
kubectl --context east exec cockroachdb-0 -n crdb-east -- \
  /cockroach/cockroach node status --certs-dir=/cockroach/cockroach-certs
```

### ExternalDNS and Cloud DNS records

```bash
# Check ExternalDNS is running in each cluster
for ctx in east central west; do
  echo "--- ${ctx} ---"
  kubectl --context "${ctx}" -n kube-system get pods -l app.kubernetes.io/name=external-dns
done

# Check ExternalDNS logs for record registration
kubectl --context east -n kube-system logs -l app.kubernetes.io/name=external-dns --tail=20

# Verify private zone records (should show A records for all 9 pods)
gcloud dns record-sets list --zone=crdb-internal \
  --project "${GCP_PROJECT_ID}" \
  --filter="type=A"

# Verify DNS resolution from inside a pod
kubectl --context east exec cockroachdb-0 -n crdb-east -- \
  nslookup cockroachdb-0.central.crdb.internal

# Verify public zone records (UI ingress)
gcloud dns record-sets list --zone=crdb-east-zone \
  --project "${GCP_PROJECT_ID}" \
  --filter="type=A"
```

### Multi-region topology

```bash
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

### Troubleshooting ExternalDNS

If CockroachDB pods fail to join across regions, ExternalDNS may not have registered pod IPs yet.

```bash
# Check ExternalDNS logs for errors
kubectl --context east -n kube-system logs -l app.kubernetes.io/name=external-dns

# Common issues:
# - "googleapi: Error 403: Forbidden" → Workload Identity binding missing or wrong project ID
# - "no endpoints found" → headless service not annotated or pods not ready
# - "zone not found" → private DNS zone not created (check shared infra deploy)

# Verify the headless service has the ExternalDNS annotation
kubectl --context east -n crdb-east get svc cockroachdb -o jsonpath='{.metadata.annotations}'

# Verify Workload Identity is working
kubectl --context east -n kube-system describe sa external-dns-sa | grep iam.gke.io

# Force ExternalDNS to re-sync by restarting it
kubectl --context east -n kube-system rollout restart deployment/external-dns
```

## Teardown

```bash
npm run teardown
```

## Cost Estimate

~$1.90/hr (~$46/day) total. Teardown after testing to avoid charges.

| Component | Per Region | 3 Regions |
|-----------|-----------|-----------|
| GKE control plane | $0.10/hr | $0.30/hr |
| 3x e2-standard-4 nodes | ~$0.40/hr | ~$1.20/hr |
| Storage (3x 100Gi pd-ssd) | ~$0.05/hr | ~$0.15/hr |
| Cloud NAT | ~$0.05/hr | ~$0.15/hr |
| KMS + Secret Manager | — | ~$0.01/hr |
| GCS backup bucket | — | ~$0.01/hr |
| Cloud Armor | — | ~$0.08/hr |

No VPN gateway costs — GCP VPC routes natively between regions.

## Project Structure

```
src/
├── shared/
│   ├── chant.config.json
│   ├── config.ts              # CIDRs, join addresses, CRDB version, regions
│   ├── encryption.ts          # KMS key ring + crypto key (90d rotation)
│   ├── storage.ts             # GCS backup bucket with lifecycle + KMS
│   ├── secrets.ts             # 5 Secret Manager secrets for TLS certs
│   ├── security.ts            # Cloud Armor WAF policy (rate limit, XSS, SQLi)
│   ├── iam-crdb.ts            # CockroachDB WI SAs + GCS backup bindings (×3)
│   ├── iam-eso.ts             # ESO WI SA + Secret Manager binding (×3)
│   └── infra/
│       ├── networking.ts      # VPC + 6 subnets + firewall + 3 NATs
│       └── dns.ts             # Cloud DNS private zone (crdb.internal)
├── east/
│   ├── chant.config.json
│   ├── config.ts              # us-east4 config
│   ├── infra/
│   │   ├── cluster.ts         # GKE cluster + zone-scoped IAM
│   │   └── dns.ts             # Cloud DNS public zone (east.<domain>)
│   └── k8s/
│       ├── namespace.ts       # NamespaceEnv + NetworkPolicy
│       ├── storage.ts         # GcePdStorageClass (pd-ssd)
│       ├── cockroachdb.ts     # CockroachDbCluster composite (WI annotated)
│       ├── ingress.ts         # GceIngress (Cloud Armor) + GkeExternalDnsAgent
│       ├── external-secrets.ts # ClusterSecretStore + ExternalSecrets
│       ├── backend-config.ts  # BackendConfig for Cloud Armor
│       └── monitoring.ts      # Prometheus deployment
├── central/                   # Same structure as east/
└── west/                      # Same structure as east/
scripts/
├── bootstrap.sh               # Management cluster + Config Connector setup
├── deploy.sh                  # Single-pass deploy orchestrator (11 steps)
├── teardown.sh                # Full teardown (ESO, K8s, infra, bucket, secrets, mgmt)
├── generate-certs.sh          # TLS cert generation + distribution
├── configure-regions.sh       # Multi-region SQL setup + demo table
└── e2e-test.sh                # Validate all resources (KMS, GCS, secrets, WAF, etc.)
```

## Source files

### Shared

| File | What it defines |
|------|-----------------|
| `src/shared/config.ts` | Cluster-wide constants: per-region CIDRs (10.1/2/3.0.0/20), Cloud DNS join addresses for all 9 nodes, CockroachDB version (v24.3.0), project ID, KMS/backup names |
| `src/shared/encryption.ts` | KMS key ring (`crdb-multi-region`, location `us`) + crypto key (`crdb-encryption`, 90-day rotation) |
| `src/shared/storage.ts` | GCS backup bucket (`${PROJECT}-crdb-backups`, versioning, nearline after 30d, delete after 90d, KMS encrypted) |
| `src/shared/secrets.ts` | 5 Secret Manager secrets for TLS certs (ca, node cert/key, client root cert/key) |
| `src/shared/security.ts` | Cloud Armor WAF policy (`crdb-ui-waf`): rate limiting, XSS/SQLi blocking, L7 DDoS defense |
| `src/shared/iam-crdb.ts` | 3 CockroachDB GCP SAs with WI bindings + bucket-scoped `storage.objectAdmin` for backups |
| `src/shared/iam-eso.ts` | ESO GCP SA with 3 WI bindings + `secretmanager.secretAccessor` for cert syncing |
| `src/shared/infra/networking.ts` | VpcNetwork (global VPC, 6 subnets: nodes + pods per region, Cloud NAT for us-east4), Router + RouterNAT for us-central1 and us-west1 |
| `src/shared/infra/dns.ts` | Cloud DNS private zone (`crdb.internal`) visible to all 3 clusters via shared VPC |

### East (us-east4)

**Infrastructure** (`src/east/infra/` → `dist/east-infra.yaml`)

| File | Resources |
|------|-----------|
| `src/east/config.ts` | East-specific config (cluster name, region, namespace, locality, crdbGsaEmail) |
| `src/east/infra/cluster.ts` | GKE cluster (3x e2-standard-4), GCP ServiceAccount, 3x IAMPolicyMember (WI + public zone DNS + private zone DNS) |
| `src/east/infra/dns.ts` | Cloud DNS public zone (`east.<domain>`) |

**Kubernetes** (`src/east/k8s/` → `dist/east-k8s.yaml`)

| File | Resources |
|------|-----------|
| `src/east/k8s/namespace.ts` | NamespaceEnv (crdb-east), ResourceQuota (10 CPU / 40Gi), LimitRange, 2x NetworkPolicy (default-deny + CRDB cross-region allow) |
| `src/east/k8s/storage.ts` | GcePdStorageClass (pd-ssd) |
| `src/east/k8s/cockroachdb.ts` | CockroachDbCluster composite: StatefulSet (3 replicas), Services (headless for ExternalDNS), RBAC, PDB, WI annotation on SA |
| `src/east/k8s/ingress.ts` | GceIngress (Cloud Armor backend-config annotation), GkeExternalDnsAgent |
| `src/east/k8s/external-secrets.ts` | ClusterSecretStore (GCP SM + WI auth), 2x ExternalSecret (node certs, client certs) |
| `src/east/k8s/backend-config.ts` | BackendConfig CRD referencing `crdb-ui-waf` Cloud Armor policy |
| `src/east/k8s/monitoring.ts` | Prometheus ConfigMap + Deployment + Service (scrapes `/_status/vars` on port 8080) |

### Central (us-central1)

Same structure as East — `src/central/` → `dist/central-infra.yaml` + `dist/central-k8s.yaml`

### West (us-west1)

Same structure as East — `src/west/` → `dist/west-infra.yaml` + `dist/west-k8s.yaml`

## Resource counts

| Stack | Lexicon | Approximate resources |
|-------|---------|-----------------------|
| Shared infra | GCP (Config Connector) | ~30 |
| East infra | GCP (Config Connector) | ~8 |
| East K8s | K8s | ~25 |
| Central infra | GCP (Config Connector) | ~8 |
| Central K8s | K8s | ~25 |
| West infra | GCP (Config Connector) | ~8 |
| West K8s | K8s | ~25 |
| **Total** | | **~129** |

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

- **Inter-node + client:** Self-signed CA via `cockroach cert` (generated locally, pushed to Secret Manager, synced to K8s via External Secrets Operator). One node cert with SANs for all 9 nodes across all 3 clusters — includes both Cloud DNS names (`*.{region}.crdb.internal`) and cluster-local names.
- **Secret Manager + ESO:** Certificates are stored in GCP Secret Manager (5 secrets: ca.crt, node.crt, node.key, client.root.crt, client.root.key). ESO in each cluster syncs them into K8s Secrets via Workload Identity — no manual `kubectl create secret` needed after initial push.
- **Dashboard UI:** Public Ingress on `{region}.<CRDB_DOMAIN>` via GCE Ingress, protected by Cloud Armor WAF.
- **Multi-region cert generation:** Uses `scripts/generate-certs.sh` (external). The K8s composite's built-in cert-gen Job is for single-cluster deployments only.

## Security hardening

1. **Pod Security Standards** — all namespaces enforce `baseline` with `restricted` warn/audit, blocking privileged containers
2. **Default-deny NetworkPolicy** — each namespace starts with deny-all ingress; a second policy explicitly allows CockroachDB ports (26257 gRPC, 8080 HTTP) only from the 6 regional CIDRs (3 node + 3 pod subnets)
3. **Cloud DNS private zone** — inter-node discovery uses a private DNS zone visible only within the VPC; no public DNS exposure of pod IPs
4. **Encrypted inter-node traffic** — CockroachDB TLS with self-signed CA; all node-to-node and client-to-node traffic is mTLS
5. **KMS encryption at rest** — CMEK via Cloud KMS (`crdb-encryption` key, 90-day auto-rotation, GOOGLE_SYMMETRIC_ENCRYPTION); encrypts GCS backup bucket
6. **Native VPC routing** — cross-region traffic stays on Google's private network backbone; never traverses the public internet
7. **Workload Identity** — Workload Identity Federation on GKE; no long-lived credentials in K8s. CockroachDB pods use per-region GCP SAs for GCS backup access
8. **Zone-scoped IAM** — ExternalDNS SAs only get `dns.admin` on their own public zone + shared private zone (not project-level)
9. **Secret Manager + ESO** — TLS certificates stored in Secret Manager and synced to K8s via External Secrets Operator with Workload Identity auth
10. **Cloud Armor WAF** — rate limiting (100 req/min per IP, 5-min ban), XSS/SQLi blocking (`xss-v33-stable`, `sqli-v33-stable`), Layer 7 DDoS defense
11. **Resource quotas + LimitRange** — each namespace caps at 10 CPU / 40Gi memory with per-pod defaults and limits
12. **Non-root containers** — CockroachDB runs as non-root (UID 1000) with read-only root filesystem where supported
13. **PodDisruptionBudget** — ensures at least 2 of 3 pods per region remain available during node maintenance
14. **Automated backups** — daily full backups to GCS with lifecycle (nearline after 30d, delete after 90d)
15. **Prometheus monitoring** — per-region Prometheus scraping CockroachDB `/_status/vars` metrics

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
npm run bootstrap  # one-time: management cluster + Config Connector
npm run deploy     # single-pass deploy across 3 GCP regions
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
