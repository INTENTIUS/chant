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
| `gitlab-cells` | `.claude/skills/` | Cells-specific operations: local k3d smoke test, routing, per-cell runners, health monitoring |

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
|  +--- kube-system namespace --------+                           |
|  |  External Secrets Operator       |                           |
|  |    (cluster-scoped operator)     |                           |
|  +-----------------------------------+                          |
|                                                                   |
|  +--- system namespace ----------------------------------------+ |
|  |  NGINX Ingress Controller (TLS termination, PDB, HPA)       | |
|  |  Cell Router (session/token/path routing, HPA 1-3)          | |
|  |  cert-manager (Let's Encrypt ClusterIssuer)                 | |
|  |  external-secrets-sa (Workload Identity SA for ESO)         | |
|  |  ClusterSecretStore (gcp-secret-manager)                    | |
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

See [Managing Cells](#managing-cells) for the full walkthrough: adding a cell, upgrading tiers, and removing a cell.

## Prerequisites

```bash
bash scripts/check-prereqs.sh
```

| Tool | Minimum version | Notes |
|------|----------------|-------|
| Node.js / Bun | 18+ | For `npm run build` / `chant` |
| gcloud | 450+ | `gcloud auth login && gcloud auth application-default login` |
| kubectl | 1.28+ | Configured by `npm run configure-kubectl` |
| helm | 3.14+ | Required for GitLab chart install |
| jq | any | Used in `load-outputs.sh` |
| docker | any | For building cell-router and topology-service images |
| openssl | any | For cert inspection |
| python3 | any | For `scripts/create-root-pat.py` |

A GCP project with billing enabled is required. A domain you control is **required** — cert-manager uses DNS-01 challenge for TLS, so DNS delegation must be completed during bootstrap (a ~5-minute window after the Cloud DNS zone is created). See [DNS Delegation](#dns-delegation-one-time-setup).

**Regional GKE cluster node count:** `minNodeCount` in `src/config.ts` is **per availability zone**. A regional cluster uses 3 zones by default, so `minNodeCount: 3` means 9 nodes minimum (`3 zones × 3`). Plan capacity accordingly.

## Local Verification (no GCP)

```bash
cd examples/gitlab-cells-single-region-gke
npm install
npm run build    # generates config.yaml, k8s.yaml, gitlab-cell/, .gitlab-ci.yml
npm run lint     # validates all 4 lexicons
```

## Local Routing Smoke Test (no GCP, ~3 min)

Validates cell-router + topology-service routing logic using k3d and nginx stubs:

```bash
npm run test:local
```

**Prerequisites:** k3d, helm, docker (in addition to the tools above)

**What it tests:**

Direct routing (cell-router NodePort, `localhost:8080`):
1. `_gitlab_session=cell1_*` cookie → routed to cell-alpha
2. `glrt-cell_2_*` Bearer token → routed to cell-beta
3. `/some-org/project` path fallback → topology service → alpha
4. `_gitlab_session=cell2_*` cookie → routed to cell-beta
5. `glrt-cell_1_*` Bearer token → routed to cell-alpha
6. `/healthz` health endpoint → 200 ok

Nginx ingress wildcard routing (`localhost:8081`, with `Host:` headers):
7. `Host: gitlab.alpha.<domain>` → matches `*.alpha.<domain>` per-cell wildcard → alpha
8. `Host: gitlab.beta.<domain>` → matches `*.beta.<domain>` per-cell wildcard → beta
9. `Host: alpha.<domain>` → matches `*.<domain>` top-level wildcard → alpha

Tests 7–9 catch the nginx subdomain-depth bug: `*.domain` only matches one subdomain level, so cell URLs like `gitlab.alpha.domain` require explicit per-cell wildcard rules.

No GCP, no real GitLab chart, no Cloud SQL required. The real topology-service image runs without a DB and returns "alpha" as the default cell.

## Deploy

### 1. Configure

```bash
cp .env.example .env
# Edit .env with your GCP project, domain, SMTP settings
```

### 2. Bootstrap (one-time, ~10 min)

```bash
bash scripts/check-prereqs.sh   # verify tools first
npm run bootstrap               # creates VPC + subnet + GKE cluster + Config Connector
```

**DNS delegation** (do this during bootstrap): once the Cloud DNS zone is created (~5 min into bootstrap), delegate your domain. See [DNS Delegation](#dns-delegation-one-time-setup) below. cert-manager cannot issue TLS certificates until DNS is delegated.

### 3. Deploy (~50–70 min total)

```bash
npm run deploy
```

This runs: build → configure-kubectl → deploy-infra → load-outputs → rebuild K8s → apply system → apply cells → deploy cells (canary first).

#### Phase timing estimates

| Phase | Typical time | Notes |
|-------|-------------|-------|
| Bootstrap (GKE creation) | 8–12 min | Do DNS delegation now |
| Cloud SQL HA provisioning (per cell) | 10–15 min each | Runs in parallel |
| Redis provisioning (per cell) | 3–5 min each | Runs in parallel |
| cert-manager cert issuance | 2–5 min | Requires DNS delegation first |
| GitLab chart migrations (`db:migrate`) | 8–15 min | Per cell, sequential |
| **Total** | **~50–70 min** | |

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
| `k3d.yaml` | K8s | Local smoke test manifests (build:k3d) |
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

> **Warning:** `values-{cell}.yaml` files are not committed to git. Losing them requires re-running `load-outputs.sh`, which is idempotent for secrets but must be able to reach live GCP state. Keep a copy somewhere safe (e.g. encrypted in a secrets manager or a private repo) if you need to recover from a workstation loss.

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

### K3d Smoke Test (`k3d/`)

| File | Contents |
|------|----------|
| `cluster.ts` | k3d cluster config + shared constants (image tags, ports, NodePort numbers) |
| `mock-cell.ts` | nginx stub factory: Deployment + Service + nginx ConfigMap per cell (port 8181 only) |
| `index.ts` | All smoke-test K8s resources (cell-router, topology-service, mock cells, nginx Ingress) |

### Helm (`src/helm/`)

| File | Output |
|------|--------|
| `gitlab-cell.ts` | Wrapper chart with `gitlab/gitlab` dependency, cell-specific values |

### Pipeline (`src/pipeline/`)

| File | Output |
|------|--------|
| `index.ts` | 9-stage GitLab CI pipeline |

## DNS Delegation (One-Time Setup)

DNS delegation is **required before TLS certificates can be issued**. Do this during bootstrap while waiting for Cloud SQL to provision.

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

**Note:** Cell-to-cell communication and Config Connector resources work without DNS delegation. Public HTTPS access (UI, API, git clone) won't resolve until delegation is complete. cert-manager DNS-01 challenge will time out if delegation is missing.

## How Routing Works for Users

Users always visit **`gitlab.example.com`** — the bare domain. Cell assignment is invisible.

```
User request → NGINX Ingress → Cell Router
                                  ↓
                     Has _gitlab_session cookie?
                     (e.g. _gitlab_session=cell1_abc...)
                          /          \
                        yes           no
                          ↓            ↓
                   Route to       Has glrt-cell_N_ Bearer token?
                   cell-alpha        /          \
                                   yes           no
                                    ↓             ↓
                              Route to       Path lookup via
                              cell-beta      Topology Service
                                             (org slug → cell)
                                                   ↓
                                              Route to correct cell
```

- **First visit** (no session cookie, no routable token): Topology Service resolves the org slug from the URL path to a cell. If the path has no registered org yet, the request is sent to the canary cell.
- **Return visits**: The `_gitlab_session` cookie carries a cell prefix (`cell1_` → alpha, `cell2_` → beta). Routing is stateless — no topology lookup needed.
- **CI jobs**: Runners receive routable tokens (`glrt-cell_1_abc`) that encode the cell. The router forwards the job API calls to the correct cell without a database lookup.

`gitlab.alpha.example.com` and `gitlab.beta.example.com` are **operator/admin URLs** — direct access to a specific cell, bypassing the router. Use them for health checks, per-cell admin, and debugging. Users should bookmark `gitlab.example.com`, not the per-cell subdomains.

## Architecture Notes

### Nginx wildcard routing (two levels of wildcards)

Nginx wildcard `*.gitlab.example.com` only matches **one** subdomain level. Cell URLs like `gitlab.alpha.gitlab.example.com` are two levels deep. The cell-router Ingress therefore includes:
- `*.gitlab.example.com` — top-level aliases (e.g. `alpha.gitlab.example.com`)
- `*.alpha.gitlab.example.com`, `*.beta.gitlab.example.com` — two-level cell hostnames

This is declared in `src/system/cell-router.ts` and generated automatically for each cell in `cells[]`.

### Port 8181 vs 8080 (critical for git over HTTP)

GitLab webservice exposes two ports:
- **8080** — puma/Rails directly. No workhorse. Returns `403 Nil JSON web token` for git operations.
- **8181** — workhorse TCP listener. Required for git HTTP clone/push (JWT generation).

The cell-registry.json in the routing-rules ConfigMap targets port **8181** for all cells. Pointing it at 8080 breaks `git clone` and `git push` with a misleading 403 error.

### Workhorse NetworkPolicy label

The NetworkPolicy allowing egress from the cell-router to nginx ingress pods uses:
```
app.kubernetes.io/name: ingress-nginx-controller
```
Not `ingress-nginx`. The Helm chart installs pods with the `-controller` suffix in the label value.

## Topology Service

The topology service maps org slug → cell assignment and is consulted on every request that doesn't already have a routable session token.

**Health check:**
```bash
kubectl -n system exec deploy/topology-service -- wget -qO- http://localhost:8080/healthz
```

**Failure behavior:** If the topology service is unavailable, requests fall back to the **canary cell** (the cell with `canary: true` in `src/config.ts`). No data loss; users see a slightly degraded routing experience until it recovers.

**HA mode:** Set `topologyDbHighAvailability: true` in `shared` config → Cloud SQL HA for the topology DB. Recommended for production. In-place upgrade (~60s window):
```bash
npm run build && kubectl apply -f dist/config.yaml
```

**Logs:**
```bash
kubectl -n system logs deploy/topology-service
```

**Org assignment:** The first time a user from an org visits, the topology service assigns them a cell and writes the mapping. Subsequent visits use the session token — no topology lookup needed.

## Common Issues Runbook

| Symptom | Cause | Fix |
|---------|-------|-----|
| 404 for all cell URLs | nginx wildcard only matches 1 subdomain level | Verify per-cell Ingress rules: `kubectl get ingress -n system cell-router -o yaml` |
| 504 gateway timeout | NetworkPolicy blocking nginx→cell-router | Check label selector: pod must have `app.kubernetes.io/name: ingress-nginx-controller` |
| 403 "Nil JSON web token" on git clone | Cell registry using port 8080 (puma) not 8181 (workhorse) | Check `kubectl get configmap cell-router-rules -n system -o jsonpath='{.data.cell-registry\.json}'` |
| 500 from cell-router on any request | lua-resty-http missing or wrong path | Rebuild cell-router image; verify `http_connect.lua` is present |
| cert-manager cert not issued | DNS delegation incomplete or DNS-01 timeout | `kubectl describe certificate gitlab-tls -n system`; verify `dig NS ${DOMAIN}` |
| ESO not syncing secrets | ClusterSecretStore not Ready | `kubectl describe clustersecretstore gcp-secret-manager` |
| Cloud SQL wait times out | HA instance + read replica slow (~15 min) | Re-run `npm run deploy` (idempotent); check `kubectl get sqlinstances` |
| Teardown leaves Cloud SQL/Redis | CC controller not running during delete | `npm run teardown -- --yes` runs `gcloud sql/redis delete` fallback automatically |
| `git push` hangs then 0 bytes | Workhorse not receiving request | Verify cell-router egress NetworkPolicy allows port 8181 to cell namespaces |
| Topology service 502 | Cloud SQL not reachable or credentials wrong | `kubectl logs -n system deploy/topology-service`; service runs without DB (returns alpha default) |
| Runner 403 on registration | Routable token format wrong | Token must match `glrt-cell_<id>_<random>`; check `scripts/e2e-test.sh` register step |
| `! ...` bash history expansion | Using `!` in shell | Use `scripts/create-root-pat.py` instead of inline bash for PAT creation |
| `deploy.sh` hangs at `kubectl wait --for=condition=Ready sqlinstances` | HA Cloud SQL + read replica provision takes 15–20 min | Normal — wait it out, or `Ctrl-C` and re-run `npm run deploy` (idempotent). Check progress: `kubectl get sqlinstances -w` |
| `npm run build` throws `Duplicate cellId` or `sequenceOffsets are too close` | Two cells in `src/config.ts` share a cellId or have sequenceOffsets within 1M of each other | See [Managing Cells → Adding a cell](#adding-a-cell) for valid cellId and sequenceOffset constraints |

## Per-Cell Runners

Each cell deploys a GitLab Runner pod, but runners are **non-functional until the `register-runners` pipeline job runs**. This is by design: the runner token is a routable token (`glrt-cell_N_...`) that must be issued by the GitLab Rails API.

**Lifecycle:**

1. `deploy-cell-<name>` (Helm install) — Runner pod starts. The token volume is `optional: true`, so the pod comes up healthy with no token and picks up zero jobs.
2. `register-runners` (pipeline job, runs after all cells are up) — calls the GitLab API to create a project runner with a routable token, stores the token as a K8s Secret, then restarts the runner Deployment.
3. After restart, the runner reads the token Secret, registers with GitLab, and starts polling for jobs.

**Checking runner status:**
```bash
kubectl -n cell-alpha logs deploy/gitlab-cell-alpha-runner | grep -E "(Checking for jobs|registered|ERROR)"
```

If the runner pod is up but no jobs run, check that the `register-runners` job completed successfully in the GitLab pipeline.

## Backup and Restore

### Backup

The `backup-gitaly` scheduled pipeline job runs `gitaly-backup create` per cell and stores backups in GCS:

```
gs://{GCP_PROJECT_ID}-{cell}-artifacts/gitaly-backups/
```

Cloud SQL automated backups are enabled for all instances (daily, 7-day retention) and configurable in `src/gcp/databases.ts`.

### Restore

**Gitaly (git data):**
```bash
# From a toolbox pod in the target cell
kubectl -n cell-alpha exec statefulset/gitlab-cell-alpha-gitaly -- \
  gitaly-backup restore --server-side \
  --path "gs://${GCP_PROJECT_ID}-alpha-artifacts/gitaly-backups/<backup-id>"
```

**Cloud SQL (PostgreSQL):**
```bash
# List available automated backups
gcloud sql backups list --instance gitlab-alpha-db --project "${GCP_PROJECT_ID}"

# Restore to a new instance (in-place restore also available)
gcloud sql backups restore <backup-id> \
  --restore-instance gitlab-alpha-db-restored \
  --backup-instance gitlab-alpha-db \
  --project "${GCP_PROJECT_ID}"
```

**Redis:** Redis stores ephemeral data (sessions, cache, Sidekiq queues). No restore is needed — after a Redis failure, users re-authenticate and Sidekiq picks up any jobs that were re-enqueued from the database.

## Upgrading GitLab

1. Update `gitlabChartVersion` in `src/config.ts`
2. Rebuild: `npm run build`
3. Preview the diff on the canary cell:
   ```bash
   helm diff upgrade gitlab-alpha gitlab-cell/ \
     -f gitlab-cell/values.yaml \
     -f gitlab-cell/values-base.yaml \
     -f values-alpha.yaml
   ```
4. Upgrade canary first:
   ```bash
   helm upgrade gitlab-alpha gitlab-cell/ \
     -f gitlab-cell/values.yaml -f gitlab-cell/values-base.yaml -f values-alpha.yaml \
     --namespace cell-alpha --timeout 20m --wait
   ```
5. Watch for DB migrations completing:
   ```bash
   kubectl -n cell-alpha logs deploy/gitlab-cell-alpha-toolbox -f | grep -E "(db:migrate|Migrations|DONE)"
   ```
6. If migration succeeds, upgrade remaining cells.
7. **Rollback (Helm only):**
   ```bash
   helm rollback gitlab-alpha --namespace cell-alpha
   ```
   > Note: Helm rollback reverts the chart but does **not** roll back DB migrations. Check the GitLab release notes for the chart version to understand whether migrations are reversible before downgrading.

## Managing Cells

### Adding a cell

Add a new `CellConfig` entry to the `cells[]` array in `src/config.ts`. Every field must be populated — here is a complete example for a hypothetical "gamma" cell:

```typescript
{
  name: "gamma",
  cellId: 3,                      // must be unique — embedded in runner tokens (glrt-cell_3_...)
  sequenceOffset: 2000000,        // must be >= 1M apart from all other cells (ID space partition)
  ...cellTierDefaults("starter"),
  pgTier: "db-custom-2-7680",
  pgDiskSize: 20,
  redisPersistentSizeGb: 3,
  redisCacheSizeGb: 1,
  bucketLocation: "US",
  artifactRetentionDays: 30,
  host: `gitlab.gamma.${shared.domain}`,
  cpuQuota: "64",
  memoryQuota: "128Gi",
  canary: false,                  // set canary: true on exactly one cell — the default landing cell for new users
  gitalyDiskSizeGb: 50,
  runnerConcurrency: 10,
  runnerReplicas: 1,
  sidekiqQueues: [
    { name: "all-queues", queues: ["*"], replicas: 1, cpuRequest: "500m", memoryRequest: "1Gi" },
  ],
},
```

After editing `src/config.ts`, run:

```bash
npm run build                                        # regenerates config.yaml, k8s.yaml, helm values
kubectl apply -f dist/config.yaml -f dist/k8s.yaml  # provisions GCP resources + K8s namespace
helm install gitlab-gamma gitlab-cell/ \
  -f gitlab-cell/values.yaml -f gitlab-cell/values-base.yaml -f values-gamma.yaml \
  --namespace cell-gamma --create-namespace --timeout 20m --wait
bash scripts/register-runners.sh gamma              # registers the per-cell runner token
bash scripts/e2e-test.sh gamma                      # smoke-test routing to the new cell
```

**Constraints:**
- `cellId` must be unique across all cells — it is embedded in runner tokens (`glrt-cell_<id>_`) and the session cookie prefix.
- `sequenceOffset` must be at least 1,000,000 apart from every other cell — GitLab uses this to partition database row IDs; overlapping ranges cause silent ID collisions.
- `canary: true` should be set on **exactly one cell** — this is the default landing cell for new users who have no org assignment yet. Typically leave it on `alpha`.

### Upgrading a cell's tier

| Field | Upgrade method | Expected downtime | Can batch? |
|---|---|---|---|
| `pgHighAvailability` | `kubectl apply` (Config Connector) | ~60s maintenance window | Yes |
| `pgReadReplicas` | `kubectl apply` (Config Connector) | 10–15 min | Yes |
| `pgBouncerEnabled` | `kubectl apply` (Config Connector) | Zero (rolling) | Yes |
| `redisPersistentTier` / `redisCacheTier` | `scripts/redis-cutover.sh` | 5–10 min (Sidekiq drained) | No — each separately |
| `webserviceReplicas` | `helm upgrade` | Zero (rolling) | Yes |

For **in-place fields** (`pgHighAvailability`, `pgReadReplicas`, `pgBouncerEnabled`, `webserviceReplicas`): edit `src/config.ts`, then:

```bash
npm run build && kubectl apply -f dist/config.yaml   # Cloud SQL fields (~60s maintenance window)
npm run build && helm upgrade gitlab-alpha gitlab-cell/ \
  -f gitlab-cell/values.yaml -f gitlab-cell/values-base.yaml -f values-alpha.yaml \
  --namespace cell-alpha --timeout 20m --wait        # Helm fields (zero-downtime rolling)
```

For **Redis tier upgrade** (`redisPersistentTier` / `redisCacheTier`): Memorystore Redis cannot be upgraded in-place from BASIC to STANDARD_HA — a new instance is required. Edit the field first, then run the cutover script (it handles drain + swap + restore):

```bash
npm run build
bash scripts/redis-cutover.sh --cell alpha --type persistent   # ~5–10 min, Sidekiq drained
bash scripts/redis-cutover.sh --cell alpha --type cache
bash scripts/redis-cutover.sh --cell beta --type persistent
bash scripts/redis-cutover.sh --cell beta --type cache
```

The script drains Sidekiq to 0 replicas, waits 30s for in-flight jobs to finish, creates the new STANDARD_HA instance, fetches its host, prompts for `kubectl apply` and `helm upgrade`, then restores Sidekiq. Web and API remain up during the window; background jobs pause briefly.

### Removing a cell

1. **Migrate all orgs off the cell** (repeat per org, or use the `migrate-org` pipeline job):
   ```bash
   kubectl -n system exec deploy/topology-service -- \
     topology-cli migrate-org --org $ORG_ID --target-cell $TARGET_CELL
   ```

2. **Verify no orgs remain on the cell:**
   ```bash
   kubectl -n system exec deploy/topology-service -- \
     topology-cli list-orgs --cell $CELL_NAME
   ```

3. **Drain in-flight CI jobs:** Scale Sidekiq to 0 and wait for queue depth to reach 0 (or adapt step 2 of `scripts/redis-cutover.sh`):
   ```bash
   kubectl -n cell-<name> scale deploy -l sidekiq=true --replicas=0
   # wait until: kubectl -n cell-<name> exec deploy/... -- gitlab-rake sidekiq:queue:size returns 0
   ```

4. **Remove the `CellConfig` entry** from `src/config.ts` and rebuild:
   ```bash
   npm run build
   ```

5. **Apply the updated manifests** — cell-router ConfigMap updates; Config Connector begins deleting cell resources:
   ```bash
   kubectl apply -f dist/config.yaml -f dist/k8s.yaml
   ```

6. **Delete the cell namespace** once all pods have terminated:
   ```bash
   kubectl delete ns cell-<name>
   ```

7. **GCP cleanup happens automatically** via Config Connector reconcile — Cloud SQL, Memorystore, GCS buckets, and IAM bindings are removed when the Config Connector resources are deleted.

## Teardown

```bash
npm run teardown           # interactive cluster deletion prompt
npm run teardown -- --yes  # non-interactive (CI/automation)
```

Teardown order: helm uninstall all cells → delete K8s resources → delete Config Connector resources → gcloud fallback delete (SQL + Redis) → optional cluster delete.

The `--yes` flag (or `TEARDOWN_CLUSTER=yes` env var) skips the interactive cluster deletion prompt and also runs direct `gcloud sql instances delete` / `gcloud redis instances delete` as a fallback in case the Config Connector controller was not running when resources were deleted.

## Related Examples

- `k8s-gke-microservice` — GCP + K8s cross-lexicon pattern (Config Connector + workloads)
- `cockroachdb-multi-region-gke` — Multi-region stateful deployment with 2 lexicons (GCP, K8s)
