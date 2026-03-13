# gitlab-cells-single-region-gke

Real GitLab with **Cells architecture** on GKE. 4 lexicons (GCP, K8s, Helm, GitLab) generate all infrastructure, K8s resources, Helm charts, and CI pipeline for a multi-cell GitLab deployment.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `npm install`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-gke` | `@intentius/chant-lexicon-gcp` | End-to-end GKE workflow: VPC, cluster, Config Connector, K8s workloads |
| `chant-gcp` | `@intentius/chant-lexicon-gcp` | Config Connector lifecycle: build, lint, deploy, rollback |
| `chant-gcp-security` | `@intentius/chant-lexicon-gcp` | GCP security: Workload Identity, KMS, VPC-SC, IAM least-privilege |
| `chant-k8s` | `@intentius/chant-lexicon-k8s` | K8s composites reference: decision tree, build/lint/apply, troubleshooting |
| `chant-k8s-gke` | `@intentius/chant-lexicon-k8s` | GKE-specific composites: Workload Identity, GCE ingress, PD, ExternalDNS |
| `chant-k8s-patterns` | `@intentius/chant-lexicon-k8s` | Advanced K8s patterns: sidecars, TLS, monitoring, network isolation |
| `chant-k8s-deployment-strategies` | `@intentius/chant-lexicon-k8s` | Deployment strategies: canary, blue-green, stateful workloads, RBAC |
| `chant-k8s-security` | `@intentius/chant-lexicon-k8s` | K8s security: pod security, network policies, image scanning, secrets |
| `chant-helm` | `@intentius/chant-lexicon-helm` | Helm lifecycle: build, lint, package, install, upgrade, rollback |
| `chant-helm-chart-patterns` | `@intentius/chant-lexicon-helm` | Helm patterns: wrapper charts, dependencies, value overrides |
| `chant-helm-chart-security-patterns` | `@intentius/chant-lexicon-helm` | Helm security: RBAC, PSS, network policies, secret management |
| `chant-gitlab` | `@intentius/chant-lexicon-gitlab` | GitLab CI lifecycle: build, lint, validate pipeline |
| `gitlab-ci-patterns` | `@intentius/chant-lexicon-gitlab` | GitLab CI patterns: multi-stage, matrix, artifacts, environments |
| `gitlab-cells` | `.claude/skills/` | Cells-specific operations: routing, per-cell runners, health monitoring |

> **Using Claude Code?** Ask your agent to deploy, passing your domain:
>
> ```
> Deploy the gitlab-cells-single-region-gke example. My domain is gitlab.mycompany.com.
> ```
>
> Your agent will use `chant-gke`, `chant-helm`, and `chant-gitlab` to walk through the full standup.

## Architecture

```
Cloud DNS: *.gitlab.example.com
     |
     v
+--- GKE Cluster (shared, single region) -------------------------+
|                                                                   |
|  +--- system namespace ----------------------------------------+ |
|  |  NGINX Ingress Controller (TLS termination, PDB, HPA)       | |
|  |  Cell Router (session/token/path routing, HPA 1-3)          | |
|  |  cert-manager (Let's Encrypt ClusterIssuer)                 | |
|  |  External Secrets Operator (syncs from Secret Manager)      | |
|  |  GitLab Runner (shared runner fleet targeting canary cell)  | |
|  |  Prometheus (cell-aware scrape + PrometheusRule CRDs)       | |
|  |  Topology Service (Go, Cloud SQL, ServiceMonitor)           | |
|  +--------------------------------------------------------------+ |
|                     |                                             |
|            routes via session/token/path                         |
|                     |                                             |
|  +--- cell-alpha ----------------+  +--- cell-beta --------+    |
|  |  GitLab (Helm release)       |  |  GitLab (Helm)       |    |
|  |    Webservice (Puma)          |  |    Webservice         |    |
|  |    PgBouncer                  |  |    PgBouncer          |    |
|  |    Sidekiq (queue-isolated)   |  |    Sidekiq            |    |
|  |    Gitaly (PVC-backed)        |  |    Gitaly             |    |
|  |    GitLab Shell               |  |    GitLab Shell       |    |
|  |    Registry                   |  |    Registry           |    |
|  |  Runner (alpha-runner pod)    |  |  Runner (beta-runner) |    |
|  |  NetworkPolicy: no cross-cell |  |  NetworkPolicy        |    |
|  |  ExternalSecrets: PG, Redis   |  |  ExternalSecrets      |    |
|  +-------------------------------+  +----------------------+    |
+-------------------------------------------------------------------+

External (per cell):
  Cloud SQL PostgreSQL -- per-cell database + optional read replica
  Memorystore Redis ---- persistent (queues) + cache (sessions)
  GCS Bucket ----------- artifacts + registry
  Secret Manager ------- per-cell secrets (PG pw, Redis, root pw, Rails)

Global:
  Cloud SQL PostgreSQL -- topology-service DB
  Cloud DNS ------------- *.gitlab.example.com
  KMS Key Ring ---------- encryption at rest
```

## GitLab Cells Concept Mapping

| GitLab Concept | Our Implementation |
|----------------|-------------------|
| Cloudflare Worker (HTTP Router) | Cell Router Deployment (system ns) + routing rules ConfigMap |
| Cell-local CI runners (per-cell token routing) | Per-cell runner Deployment in cell-{name} namespace + routable token format |
| Cell health → routing decisions | PrometheusRule CRDs + topology-service ServiceMonitor + health-aware router |
| Topology Service (Cloud Spanner) | Topology Service on Cloud SQL |
| Cell = isolated GitLab | Helm release per K8s namespace |
| Cell-local PostgreSQL | Cloud SQL instance per cell |
| Cell-local Redis | Memorystore instance per cell |
| Cell-local object storage | GCS bucket per cell |
| Private Service Connect | K8s NetworkPolicy (no cross-cell) |
| Phased deployment | Canary cell -> remaining cells |

## Config-Driven Fan-Out

All infrastructure is driven by a single `cells[]` array in `src/config.ts`. Adding a cell means adding one config entry — GCP resources, K8s namespaces, Helm releases, and pipeline jobs are all derived from this array.

## Prerequisites

- Node.js 22+ / Bun
- gcloud CLI (`gcloud auth login`)
- kubectl
- helm 3.14+
- jq
- A GCP project with billing enabled
- A domain you control (set via `DOMAIN` env var, e.g., `gitlab.mycompany.com`)

## Local Verification

No GCP required:

```bash
cd examples/gitlab-cells-single-region-gke
npm install
npm run build    # generates config.yaml, k8s.yaml, gitlab-cell/, .gitlab-ci.yml
npm run lint     # validates all 4 lexicons
```

## Deploy

### 1. Configure

```bash
cp .env.example .env
# Edit .env with your GCP project, domain, SMTP settings
```

### 2. Bootstrap (one-time)

```bash
npm run bootstrap   # creates VPC + subnet + GKE cluster + Config Connector
```

### 3. Deploy

```bash
npm run deploy
```

This runs: build → configure-kubectl → deploy-infra → load-outputs → rebuild K8s → apply system → apply cells → deploy cells (canary first).

First deploy takes ~30-45 min (Cloud SQL creation + initial `db:migrate`).

> **DNS delegation:** after deploy-infra creates the Cloud DNS zone, delegate your domain to GCP's nameservers. See [DNS Delegation](#dns-delegation-one-time-setup) below.

### 4. Verify

```bash
bash scripts/e2e-test.sh
```

Validates 10 areas: infra health, system namespace, per-cell GitLab, git operations, container registry, cell isolation, topology routing, runner, backup.

## Pipeline Stages (9)

| Stage | Job | Details |
|-------|-----|---------|
| `infra` | `deploy-gcp` | Config Connector: Cloud SQL, Redis, GCS, DNS, KMS, IAM |
| `system` | `deploy-system` | cert-manager, ESO, NGINX ingress, cell router, system K8s resources |
| `validate` | `validate-cells` | `helm diff` per cell (dry-run preview) |
| `deploy-canary` | `deploy-cell-<canary>` | Helm install canary cell, wait for rollout |
| `deploy-remaining` | `deploy-cell-*` (matrix) | Non-canary cells, depends on canary success |
| `register-runners` | `register-runners` (matrix per cell) | Create routable token per cell, store secret, restart cell runner |
| `smoke-test` | `e2e-test` | Run `scripts/e2e-test.sh` |
| `backup` | `backup-gitaly` (scheduled) | `gitaly-backup create` per cell -> GCS |
| `migrate-org` | `migrate-org` (manual) | Reassign org to target cell via Topology Service |

## Outputs

| File | Lexicon | Contents |
|------|---------|----------|
| `config.yaml` | GCP | Config Connector resources (Cloud SQL, Redis, GCS, VPC, DNS, KMS, IAM, secrets) |
| `k8s.yaml` | K8s | System namespace (ingress, cell router, cert-manager, ESO, runner, topology, monitoring) + cell namespaces (NetworkPolicy, ExternalSecrets, WI SAs, per-cell runners) |
| `gitlab-cell/Chart.yaml` | Helm | Chart metadata with `gitlab/gitlab` dependency |
| `gitlab-cell/values.yaml` | Helm | Default values (runtime slots are `''`) |
| `gitlab-cell/values-base.yaml` | Helm | Static shared overrides (generated by `ValuesOverride`) |
| `gitlab-cell/values-runtime-slots.yaml` | Helm | Runtime values contract (generated by `runtimeSlot()`) |
| `.gitlab-ci.yml` | GitLab | 9-stage pipeline with canary deployment + per-cell runner matrix |

**Deploy-time artifacts** (generated by `scripts/load-outputs.sh` from live GCP state, not tracked in source):

| File | Contents |
|------|----------|
| `values-alpha.yaml` | Per-cell Helm overrides for alpha (Cloud SQL IP, Redis hosts, LB IP, bucket names) |
| `values-beta.yaml` | Per-cell Helm overrides for beta |

## Source Files

### GCP Infrastructure (`src/gcp/`)

| File | Resources |
|------|-----------|
| `networking.ts` | VPC + subnets + Cloud NAT + PrivateService (VPC peering) |
| `cluster.ts` | GKE cluster + node pool + optional runner node pool |
| `databases.ts` | Cloud SQL per cell + read replicas + topology DB |
| `cache.ts` | Memorystore Redis per cell (persistent + cache) |
| `storage.ts` | GCS buckets per cell (artifacts + registry) |
| `dns.ts` | Cloud DNS zone + wildcard record |
| `encryption.ts` | KMS key ring + crypto key |
| `iam.ts` | Workload Identity SAs + IAM bindings (per cell, ESO, cert-manager) |
| `secrets.ts` | Secret Manager secrets per cell |
| `outputs.ts` | Cross-lexicon output references |

### K8s System (`src/system/`)

| File | Resources |
|------|-----------|
| `namespace.ts` | System namespace + ResourceQuota (32 CPU, 64Gi) |
| `storage.ts` | GcePdStorageClass (pd-ssd, for Gitaly PVCs) |
| `ingress-controller.ts` | NGINX Ingress + Service + PDB + HPA |
| `cell-router.ts` | Cell Router Deployment + Service + ConfigMap + NetworkPolicies + HPA + Ingress |
| `routing-rules.ts` | SessionTokenRule, RoutableTokenRule, PathRule declarations + routing-rules ConfigMap |
| `topology-service.ts` | Topology Service Deployment + ConfigMap (with Prometheus address) + ServiceMonitor |
| `monitoring.ts` | Prometheus + Grafana + per-cell PrometheusRule CRDs (health scores + alerts) |
| `cert-manager.ts` | ClusterIssuer (Let's Encrypt DNS-01) |
| `external-secrets.ts` | ClusterSecretStore (GCP Secret Manager) |
| `gitlab-runner.ts` | Shared runner fleet (canary cell) |

### K8s Cell (`src/cell/`)

| File | Resources |
|------|-----------|
| `factory.ts` | Cell factory: namespace, NetworkPolicies, ExternalSecrets, WI SA, per-cell runner (SA + ConfigMap + Deployment + NetworkPolicy) |
| `index.ts` | `cells.map(createCell)` — config-driven fan-out |

### Helm (`src/helm/`)

| File | Output |
|------|--------|
| `gitlab-cell.ts` | Wrapper chart with `gitlab/gitlab` dependency, cell-specific values |

### Pipeline (`src/pipeline/`)

| File | Output |
|------|--------|
| `index.ts` | 9-stage GitLab CI pipeline |

## DNS Delegation (One-Time Setup)

After Step 3 deploys infrastructure, delegate your domain to GCP Cloud DNS nameservers.

### Get nameservers

```bash
gcloud dns managed-zones describe gitlab-cells \
  --project "${GCP_PROJECT_ID}" --format='value(nameServers)'
```

### Create NS records at your registrar

At your domain registrar, create NS records pointing your domain to the Cloud DNS nameservers:

```
gitlab.mycompany.com  →  NS  (Cloud DNS zone nameservers)
```

### Verify

```bash
dig NS "${DOMAIN}"
dig A "alpha.${DOMAIN}"
```

**Note:** Cell-to-cell communication and Config Connector resources work without DNS delegation. Public HTTPS access to GitLab (UI, API, git clone) won't resolve until delegation is complete.

## Teardown

```bash
npm run teardown
```

Reverse order: helm uninstall all cells -> delete K8s resources -> delete Config Connector resources -> optional cluster delete.

## Related Examples

- `k8s-gke-microservice` — GCP + K8s cross-lexicon pattern (Config Connector + workloads)
- `cockroachdb-multi-region-gke` — Multi-region stateful deployment with 2 lexicons (GCP, K8s)
