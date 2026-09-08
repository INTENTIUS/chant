# gitlab-cells-single-region-gke

> **New to chant?** Start with the [golden teaching example](../getting-started/) — synthesis → lint → Ops → the lifecycle dial over one set of declarations — then come back here for a production-shaped deployment.

Real GitLab with **Cells architecture** on GKE. Four lexicons (GCP, K8s, Helm, GitLab) generate all infrastructure, K8s resources, Helm charts, and CI pipeline for a multi-cell GitLab deployment from `src/`. A fifth, k3d, declares the local smoke cluster in `k3d/`. `chant.config.ts` lists all five.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `npm install`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-gcp` | `@intentius/chant-lexicon-gcp` | Config Connector lifecycle: build, lint, deploy, rollback |
| `chant-gcp-gke` | `@intentius/chant-lexicon-gcp` | End-to-end GKE workflow: VPC, cluster, Config Connector, K8s workloads |
| `chant-gcp-patterns` | `@intentius/chant-lexicon-gcp` | GCP composite patterns |
| `chant-gcp-security` | `@intentius/chant-lexicon-gcp` | GCP security: Workload Identity, KMS, VPC-SC, IAM least-privilege |
| `chant-k8s` | `@intentius/chant-lexicon-k8s` | K8s composites reference: decision tree, build/lint/apply, troubleshooting |
| `chant-k8s-gke` | `@intentius/chant-lexicon-k8s` | GKE-specific composites: Workload Identity, GCE ingress, PD, ExternalDNS |
| `chant-k8s-patterns` | `@intentius/chant-lexicon-k8s` | Advanced K8s patterns: sidecars, TLS, monitoring, network isolation |
| `chant-k8s-deployment-strategies` | `@intentius/chant-lexicon-k8s` | Deployment strategies: canary, blue-green, stateful workloads, RBAC |
| `chant-k8s-security` | `@intentius/chant-lexicon-k8s` | K8s security: pod security, network policies, image scanning, secrets |
| `chant-helm` | `@intentius/chant-lexicon-helm` | Helm lifecycle: build, lint, package, install, upgrade, rollback |
| `chant-helm-patterns` | `@intentius/chant-lexicon-helm` | Helm patterns: wrapper charts, dependencies, value overrides |
| `chant-helm-security` | `@intentius/chant-lexicon-helm` | Helm security: RBAC, PSS, network policies, secret management |
| `chant-gitlab` | `@intentius/chant-lexicon-gitlab` | GitLab CI lifecycle: build, lint, validate pipeline |
| `chant-gitlab-patterns` | `@intentius/chant-lexicon-gitlab` | GitLab CI patterns: multi-stage, matrix, artifacts, environments |
| `chant-gitlab-migrate` | `@intentius/chant-lexicon-gitlab` | Migrating an existing `.gitlab-ci.yml` into chant |

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

All infrastructure is driven by a single `cells[]` array in `src/config.ts`. GCP resources, K8s namespaces, Helm releases, and pipeline jobs are all derived from it, so adding a cell is mostly one config entry. `src/helm/per-cell-values.ts` and its per-cell build parameters are the exception and need two more edits. See [Adding a cell](#adding-a-cell).

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

A GCP project with billing enabled is required. A domain you control is **required**: cert-manager uses a DNS-01 challenge for TLS, so you must delegate the domain before certificates can issue. The Cloud DNS zone is created in Phase 3 of `npm run deploy`, not by bootstrap, so that is when the nameservers become readable. See [DNS Delegation](#dns-delegation-one-time-setup).

**Regional GKE cluster node count:** `minNodeCount` is a build parameter (`chant.config.ts`, `MIN_NODE_COUNT` in `.env`), and it is **per availability zone**. A regional cluster uses 3 zones by default, so `minNodeCount: 3` means 9 nodes minimum (`3 zones × 3`). Plan capacity accordingly.

## Local Verification (no GCP)

```bash
cd examples/gitlab-cells-single-region-gke
npm install
npm run build    # config.yaml, k8s.yaml, gitlab-cell/, .gitlab-ci.yml, k3d.yaml, k3d-cluster.yaml
npm run lint     # lints src/ and k3d/
```

Both scripts cover every directory the example ships, `k3d/` included: `build` is
the six per-lexicon builds chained, `lint` is `chant lint src && chant lint k3d`.

`src/chant.config.json` and `k3d/chant.config.json` scope lint to the strict
preset with COR001 off. The preset makes COR001 an error, and the cell and system
resources here are written as one nested literal per resource rather than a named
`const` per field; everything else in strict applies to both directories.

## Local Routing Smoke Test (no GCP, ~3 min)

Validates cell-router + topology-service routing logic using k3d and nginx stubs:

```bash
npm run test:local
```

**Prerequisites:** k3d, helm, docker (in addition to the tools above)

**What it tests:**

Direct routing (cell-router NodePort, `localhost:8080`), numbered as
`scripts/k3d-validate.sh` numbers them:
1. `/healthz` health endpoint → 200 ok
2. `_gitlab_session=cell1_*` cookie → routed to cell-alpha
3. `glrt-t2_*` Bearer token → routed to cell-beta
4. `/some-org/project` path fallback → topology service → the canary cell (alpha by default)
5. `_gitlab_session=cell2_*` cookie → routed to cell-beta
6. `glrt-t1_*` Bearer token → routed to cell-alpha

Nginx ingress wildcard routing (`localhost:8081`, with `Host:` headers):
7. `Host: gitlab.alpha.<domain>` → matches `*.alpha.<domain>` per-cell wildcard → alpha
8. `Host: gitlab.beta.<domain>` → matches `*.beta.<domain>` per-cell wildcard → beta
9. `Host: alpha.<domain>` → matches `*.<domain>` top-level wildcard → alpha

Tests 7–9 catch the nginx subdomain-depth bug: `*.domain` only matches one subdomain level, so cell URLs like `gitlab.alpha.domain` require explicit per-cell wildcard rules.

No GCP, no real GitLab chart, no Cloud SQL required. The real topology-service image runs without a DB and returns "alpha" as the default cell.

**The smoke DB secret comes from outside the build.** `k3d/index.ts`'s
topology-service Deployment reads `DB_PASSWORD` from a Secret named
`topology-smoke-db-secret`, and nothing in `k3d/` produces it.
`scripts/k3d-smoke.sh` creates it with `kubectl create secret generic` before it
applies `k3d.yaml`, with a dummy value the service never successfully connects
with. A Secret consumed but not produced is a build error, so `k3d/index.ts`
declares where it comes from:

```typescript
export const topologySmokeDbSecret = declareSecret({
  name: "topology-smoke-db-secret",
  provenance: "referenced",
  scope: "namespace system, created by scripts/k3d-smoke.sh before kubectl apply",
});
```

`referenced` is the typed waiver for "produced elsewhere, on purpose". The
declaration records the name and where to look, never a value, and no serializer
emits it, so `k3d.yaml` is byte-identical with or without it. If you apply
`k3d.yaml` by hand rather than through `npm run test:local`, create the Secret
first or the pod stays in `CreateContainerConfigError`. See
[Where values come from](/chant/concepts/where-values-come-from/).

## Deploy

### 1. Configure

```bash
cp .env.example .env
# Edit .env: set GCP_PROJECT_ID, DOMAIN, and optionally SMTP_PASSWORD
```

**SMTP (optional):** GitLab works without email but won't send confirmations or notifications. Set `SMTP_PASSWORD` in `.env` to enable it:

| Provider | SMTP_ADDRESS | SMTP_USER | SMTP_PASSWORD |
|----------|-------------|-----------|---------------|
| SendGrid (free 500/day) | `smtp.sendgrid.net` | `apikey` | your SendGrid API key |
| Gmail (free 500/day) | `smtp.gmail.com` | `you@gmail.com` | 16-char [App Password](https://myaccount.google.com/apppasswords) (requires 2-Step Verification) |

Leave `SMTP_PASSWORD=` blank to skip — a placeholder is stored in Secret Manager and email is disabled. You can enable it later without redeploying:

```bash
echo -n "<password>" | gcloud secrets versions add gitlab-smtp-password \
  --data-file=- --project "${GCP_PROJECT_ID}"
```

### 2. Bootstrap (one-time, ~10 min)

```bash
bash scripts/check-prereqs.sh   # verify tools first
npm run bootstrap               # VPC + subnet + Private Service Access + GKE cluster + Config Connector + ESO + cert-manager + prometheus-operator CRDs
```

**DNS delegation** (do this as soon as `npm run deploy` starts): the Cloud DNS zone is a Config Connector `DNSManagedZone` (`src/gcp/dns.ts`), so it is created by `kubectl apply -f config.yaml` in Phase 3 of `scripts/deploy.sh`, not by bootstrap. Read the nameservers as soon as that phase runs and delegate your domain. See [DNS Delegation](#dns-delegation-one-time-setup) below. cert-manager cannot issue TLS certificates until DNS is delegated.

### 3. Deploy (~50–70 min total)

```bash
npm run deploy
```

This runs the nine phases in `scripts/deploy.sh`: optional image build/push → build all lexicons → configure-kubectl → apply Config Connector infra → wait for Cloud SQL → wait for Redis → load outputs and initialize secrets (then rebuild K8s and Helm) → apply system K8s resources and wait for the LB → apply cell K8s resources → deploy the GitLab Helm releases, canary first.

#### Phase timing estimates

| Phase | Typical time | Notes |
|-------|-------------|-------|
| Bootstrap (GKE creation) | 8–12 min | |
| Cloud SQL provisioning (per cell) | 10–15 min each | Runs in parallel; `starter` is non-HA |
| Redis provisioning (per cell) | 3–5 min each | Runs in parallel |
| cert-manager cert issuance | 2–5 min | Requires DNS delegation, which is only possible once Phase 3 has created the zone |
| GitLab chart migrations (`db:migrate`) | 8–15 min | Per cell, sequential |
| **Total** | **~50–70 min** | |

### 4. Verify

```bash
bash scripts/e2e-test.sh
```

Validates 12 areas: infra health, system namespace, per-cell GitLab, base domain routing, git operations, base domain API routing, container registry, cell isolation, topology routing, runner, backup, Grafana.

## Pipeline Stages (10)

Stage and job names below are the ones `.gitlab-ci.yml` actually emits, from
`src/pipeline/index.ts`.

| Stage | Job | Details |
|-------|-----|---------|
| `infra` | `deploy-infra` | Config Connector: Cloud SQL, Redis, GCS, DNS, KMS, IAM |
| `system` | `deploy-system` | cert-manager, ESO, NGINX ingress, cell router, system K8s resources |
| `build-helm-values` | `build-helm-values` | `npm run build:helm` → `gitlab-cell/values-*.yaml`, kept as artifacts for the next stages |
| `validate` | `validate` | `helm diff` per cell (dry-run preview, `allow_failure: true`) |
| `deploy-canary` | `deploy-canary` | Helm install the canary cell, wait for rollout |
| `deploy-remaining` | `deploy-remaining` (matrix per non-canary cell) | Non-canary cells, depends on canary success |
| `register-runners` | `register-runners` (matrix per cell) | Create routable token per cell, store secret, restart cell runner |
| `smoke-test` | `smoke-test` | Run `scripts/e2e-test.sh` |
| `backup` | `backup-gitaly` (matrix per cell, schedules only) | `backup-utility` per cell (repos + uploads + packages → GCS) |
| `migrate-org` | `migrate-org` (manual) | Reassign org to target cell via Topology Service |

## Outputs

| File | Lexicon | Contents |
|------|---------|----------|
| `config.yaml` | GCP | Config Connector resources (Cloud SQL, Redis, GCS, VPC, DNS, KMS, IAM, secrets) |
| `k8s.yaml` | K8s | System namespace (ingress, cell router, cert-manager, ESO, runner, topology, monitoring) + cell namespaces (NetworkPolicy, ExternalSecrets, WI SAs, per-cell runners) |
| `k3d.yaml` | K8s | Local smoke test manifests (`build:k3d`, from `k3d/`) |
| `k3d-cluster.yaml` | k3d | Smoke cluster shape for `k3d cluster create --config` (`build:k3d-cluster`, from `k3d/cluster.ts`) |
| `gitlab-cell/Chart.yaml` | Helm | Chart metadata with `gitlab/gitlab` dependency |
| `gitlab-cell/values.yaml` | Helm | Default values (runtime slots are `''`) |
| `gitlab-cell/values-base.yaml` | Helm | Static shared overrides (generated by `ValuesOverride`) |
| `gitlab-cell/values-runtime-slots.yaml` | Helm | Runtime values contract (generated by `runtimeSlot()`) |
| `.gitlab-ci.yml` | GitLab | 10-stage pipeline with canary deployment + per-cell runner matrix |

**Deploy-time artifacts.** `scripts/load-outputs.sh` reads live GCP state and writes
the per-cell IPs and hostnames to `.env` as the build parameters `chant.config.ts`
declares (`ALPHA_DB_IP`, `ALPHA_REDIS_PERSISTENT`, ...). `npm run build:helm` then
emits the files below from `src/helm/per-cell-values.ts`. Neither is tracked in source:

| File | Contents |
|------|----------|
| `gitlab-cell/values-alpha.yaml` | Per-cell Helm overrides for alpha (Cloud SQL IP, Redis hosts, bucket names, sidekiq pods) |
| `gitlab-cell/values-beta.yaml` | Per-cell Helm overrides for beta |

> **Warning:** `values-{cell}.yaml` files are not committed to git. Losing them requires re-running `load-outputs.sh`, which is idempotent for secrets but must be able to reach live GCP state. Keep a copy somewhere safe (e.g. encrypted in a secrets manager or a private repo) if you need to recover from a workstation loss.

## Source Files

### GCP Infrastructure (`src/gcp/`)

| File | Resources |
|------|-----------|
| `networking.ts` | VPC + subnets + Cloud NAT + PrivateService (VPC peering) |
| `cluster.ts` | GKE cluster + node pool + optional runner node pool |
| `databases.ts` | Cloud SQL per cell + read replicas + topology DB |
| `cache.ts` | Memorystore Redis per cell (persistent + cache) |
| `storage.ts` | Five GCS buckets per cell: artifacts, uploads, lfs, packages, registry |
| `dns.ts` | Cloud DNS zone + wildcard record + apex A record (a wildcard does not match the bare domain) |
| `encryption.ts` | KMS key ring + crypto key |
| `iam.ts` | Workload Identity SAs + IAM bindings (per cell, ESO, cert-manager) |
| `secrets.ts` | Secret Manager secrets per cell, plus the global SMTP, topology-DB and Grafana-admin secrets |
| `defaults.ts` | Shared Config Connector annotations applied to every GCP resource |
| `outputs.ts` | Cross-lexicon output references |

### K8s System (`src/system/`)

| File | Resources |
|------|-----------|
| `namespace.ts` | System namespace + ResourceQuota (32 CPU, 64Gi) + LimitRange |
| `storage.ts` | GcePdStorageClass (pd-ssd, for Gitaly PVCs) |
| `ingress-controller.ts` | NGINX Ingress + Service + PDB + HPA + RBAC |
| `cell-router.ts` | Cell Router Deployment + Service + NetworkPolicies + HPA + Ingress (its ConfigMap comes from `routing-rules.ts`) |
| `routing-rules.ts` | SessionTokenRule, RoutableTokenRule, PathRule declarations + the `cell-router-rules` ConfigMap |
| `topology-service.ts` | Topology Service Deployment + ConfigMap + ExternalSecret + ServiceMonitor |
| `monitoring.ts` | Prometheus (+ PVC and RBAC), Alertmanager, Grafana, per-cell PrometheusRule CRDs (health scores + alerts) |
| `cert-manager.ts` | ClusterIssuer (Let's Encrypt DNS-01) + the `gitlab-tls` wildcard Certificate |
| `external-secrets.ts` | ClusterSecretStore (GCP Secret Manager) + the `external-secrets-sa` Workload Identity SA + the `grafana-admin` ExternalSecret |
| `calico.ts` | FelixConfiguration (GKE names pod veths `gke*`, not Calico's default `cali*`) |
| `config-connector.ts` | ConfigConnectorContext binding the `config-connector` GSA |
| `gitlab-runner.ts` | Shared runner fleet (canary cell) |

### K8s Cell (`src/cell/`)

| File | Resources |
|------|-----------|
| `factory.ts` | Cell factory: namespace + ResourceQuota + LimitRange, default-deny and per-flow NetworkPolicies, ExternalSecrets (including registry-storage and object-store-connection), WI SA, default SA, per-cell runner (SA + ConfigMap + Deployment + NetworkPolicy) |
| `index.ts` | `cells.map(createCell)` — config-driven fan-out |

### K3d Smoke Test (`k3d/`)

| File | Contents |
|------|----------|
| `cluster.ts` | k3d `Cluster` (built to `k3d-cluster.yaml` by the k3d lexicon) + shared constants (image tags, ports, NodePort numbers, `SYSTEM_NS`) |
| `mock-cell.ts` | nginx stub factory: Deployment + Service + nginx ConfigMap per cell (port 8181 only) |
| `index.ts` | All smoke-test K8s resources (cell-router, topology-service, mock cells, nginx Ingress) + the `referenced` declaration for `topology-smoke-db-secret` |

### Helm (`src/helm/`)

| File | Output |
|------|--------|
| `gitlab-cell.ts` | Wrapper chart with `gitlab/gitlab` dependency, `values.yaml` runtime slots, static `values-base.yaml`, NOTES.txt, Helm test |
| `per-cell-values.ts` | `values-<cell>.yaml` per cell, from the `cells[]` array and the per-cell IP build parameters |

### Pipeline (`src/pipeline/`)

| File | Output |
|------|--------|
| `index.ts` | 10-stage GitLab CI pipeline |

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
                   Route to       Has glrt-tN_ Bearer token?
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
- **CI jobs**: Runners receive routable tokens (`glrt-t1_abc`) that encode the cell. The router forwards the job API calls to the correct cell without a database lookup.

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
npm run build && kubectl apply -f config.yaml
```

**Logs:**
```bash
kubectl -n system logs deploy/topology-service
```

**Org assignment:** The first time a user from an org visits, the topology service assigns them a cell and writes the mapping. Subsequent visits use the session token — no topology lookup needed.

## Common Issues Runbook

| Symptom | Cause | Fix |
|---------|-------|-----|
| GitLab doesn't send email (confirmations, notifications) | `SMTP_PASSWORD` was blank at deploy time | Run: `echo -n "<password>" \| gcloud secrets versions add gitlab-smtp-password --data-file=- --project $GCP_PROJECT_ID` (no redeploy needed) |
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
| Runner 403 on registration | Routable token format wrong | Token must match `glrt-t<id>_<random>` (GitLab 17.7+); check `scripts/register-runners.sh` |
| `! ...` bash history expansion | Using `!` in shell | Use `scripts/create-root-pat.py` instead of inline bash for PAT creation |
| `deploy.sh` hangs at `kubectl wait --for=condition=Ready sqlinstances` | Cloud SQL provision takes 10–15 min per cell (longer if you raised `pgHighAvailability` or `pgReadReplicas`) | Normal — wait it out, or `Ctrl-C` and re-run `npm run deploy` (idempotent). Check progress: `kubectl get sqlinstances -w` |
| `npm run build` throws `Duplicate cellId` or `sequenceOffsets are too close` | Two cells in `src/config.ts` share a cellId or have sequenceOffsets within 1M of each other | See [Managing Cells → Adding a cell](#adding-a-cell) for valid cellId and sequenceOffset constraints |

## Per-Cell Runners

Each cell deploys a GitLab Runner pod, but runners are **non-functional until the `register-runners` pipeline job runs**. This is by design: the runner token is a routable token (`glrt-t{cellId}_...`) that must be issued by the GitLab Rails API.

**Lifecycle:**

1. `deploy-canary` / `deploy-remaining` (Helm install) — Runner pod starts. The token volume is `optional: true`, so the pod comes up healthy with no token and picks up zero jobs.
2. `register-runners` (pipeline job, runs after all cells are up) — calls the GitLab API to create a project runner with a routable token, stores the token as a K8s Secret, then restarts the runner Deployment.
3. After restart, the runner reads the token Secret, registers with GitLab, and starts polling for jobs.

**Checking runner status:**
```bash
kubectl -n cell-alpha logs deploy/alpha-runner | grep -E "(Checking for jobs|registered|ERROR)"
```

If the runner pod is up but no jobs run, check that the `register-runners` job completed successfully in the GitLab pipeline.

## Backup and Restore

### Backup

The `backup-gitaly` scheduled pipeline job runs `backup-utility` in the toolbox pod per cell. It backs up repos (via Gitaly), uploads, LFS, and packages to the configured GCS artifact bucket using Workload Identity:

```
gs://{GCP_PROJECT_ID}-{cell}-artifacts/
```

`src/gcp/databases.ts` sets `backupEnabled: true` on each cell's primary and on the topology instance; schedule and retention are left at the GCP defaults (daily, 7 days) and are not declared here. Read replicas carry no `backupEnabled`.

### Restore

**Git repos + uploads (via toolbox backup-utility):**
```bash
# List available backups
gsutil ls "gs://${GCP_PROJECT_ID}-alpha-artifacts/backups/"

# Restore from a specific backup (run inside the toolbox pod)
kubectl -n cell-alpha exec deploy/gitlab-cell-alpha-toolbox -- \
  backup-utility --restore --skip-registry \
  BACKUP=<timestamp>_gitlab_backup
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
   helm diff upgrade gitlab-cell-alpha ./gitlab-cell/ \
     -n cell-alpha \
     -f gitlab-cell/values-base.yaml \
     -f gitlab-cell/values-alpha.yaml
   ```
4. Upgrade canary first:
   ```bash
   helm upgrade gitlab-cell-alpha ./gitlab-cell/ \
     -n cell-alpha \
     -f gitlab-cell/values-base.yaml -f gitlab-cell/values-alpha.yaml \
     --timeout 20m --wait
   ```
5. Watch for DB migrations completing:
   ```bash
   kubectl -n cell-alpha logs deploy/gitlab-cell-alpha-toolbox -f | grep -E "(db:migrate|Migrations|DONE)"
   ```
6. If migration succeeds, upgrade remaining cells.
7. **Rollback (Helm only):**
   ```bash
   helm rollback gitlab-cell-alpha --namespace cell-alpha
   ```
   > Note: Helm rollback reverts the chart but does **not** roll back DB migrations. Check the GitLab release notes for the chart version to understand whether migrations are reversible before downgrading.

## Managing Cells

### Adding a cell

Add a new `CellConfig` entry to the `cells[]` array in `src/config.ts`. Every field must be populated — here is a complete example for a hypothetical "gamma" cell:

```typescript
{
  name: "gamma",
  cellId: 3,                      // must be unique — embedded in runner tokens (glrt-t3_...) and session prefixes (cell3_)
  sequenceOffset: 2000000,        // must be >= 1M apart from all other cells (ID space partition)
  ...cellTierDefaults("starter"),
  pgTier: "db-custom-2-7680",
  pgDiskSize: 20,
  redisPersistentSizeGb: 3,
  redisCacheSizeGb: 1,
  bucketLocation: "US",
  artifactRetentionDays: 30,
  host: `gamma.${shared.domain}`,         // BASE domain — chart prepends "gitlab." to create gitlab.gamma.example.com
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
npm run build                                       # regenerates config.yaml, k8s.yaml, helm values
kubectl apply -f config.yaml -f k8s.yaml            # provisions GCP resources + K8s namespace
helm install gitlab-cell-gamma ./gitlab-cell/ \
  -n cell-gamma \
  -f gitlab-cell/values-base.yaml -f gitlab-cell/values-gamma.yaml \
  --create-namespace --timeout 20m --wait
CELLS=gamma bash scripts/register-runners.sh        # registers the per-cell runner token
bash scripts/e2e-test.sh                            # smoke-test (includes new cell)
```

**Two edits the `cells[]` entry does not cover.** `src/helm/per-cell-values.ts`
reads the per-cell IPs from build parameters, and both the parameter names and
the list are per cell by hand:

1. Add `gammaDbIp`, `gammaRedisPersistent` and `gammaRedisCache` to
   `chant.config.ts`'s `buildParams`, next to the alpha and beta ones.
2. Add the matching `cellEnvs` entry and the third `makeCellValues(cells[2], cellEnvs[2])`
   in `src/helm/per-cell-values.ts`. Without it there is no `values-gamma.yaml`
   for the `helm install` above to read.

**Constraints:**
- `cellId` must be unique across all cells — it is embedded in runner tokens (`glrt-t<id>_`) and the session cookie prefix (`cell<id>_`).
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
npm run build && kubectl apply -f config.yaml                           # Cloud SQL fields (~60s maintenance window)
npm run build && helm upgrade gitlab-cell-alpha ./gitlab-cell/ \
  -n cell-alpha \
  -f gitlab-cell/values-base.yaml -f gitlab-cell/values-alpha.yaml \
  --timeout 20m --wait                                                    # Helm fields (zero-downtime rolling)
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

2. **Verify no orgs remain on the cell.** `topology-cli` implements `migrate-org`
   and nothing else (`topology-service/main.go`), so query the assignment table
   the service keeps, `cell_assignments (org_slug, cell_name, cell_id, updated_at)`,
   on the topology Cloud SQL instance:
   ```bash
   gcloud sql connect gitlab-topology-db --user=gitlab-topology-db-admin --database=topology_production
   # then: select count(*) from cell_assignments where cell_name = '<cell>';
   ```

3. **Drain in-flight CI jobs:** Scale Sidekiq to 0 and wait for queue depth to reach 0 (or adapt step 2 of `scripts/redis-cutover.sh`):
   ```bash
   kubectl -n cell-<name> scale deploy -l app.kubernetes.io/component=sidekiq --replicas=0
   # wait until: kubectl -n cell-<name> exec deploy/... -- gitlab-rake sidekiq:queue:size returns 0
   ```

4. **Remove the `CellConfig` entry** from `src/config.ts` and rebuild:
   ```bash
   npm run build
   ```

5. **Apply the updated manifests** — cell-router ConfigMap updates; Config Connector begins deleting cell resources:
   ```bash
   kubectl apply -f config.yaml -f k8s.yaml
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

Teardown order: helm uninstall all cells → per-cell PVC cleanup → uninstall ESO and cert-manager → delete K8s resources → delete Config Connector resources → gcloud fallback delete (SQL + Redis) → Secret Manager cleanup → IAM service-account cleanup → optional cluster delete.

The `--yes` flag (or `TEARDOWN_CLUSTER=yes` env var) skips the interactive cluster deletion prompt and also runs direct `gcloud sql instances delete` / `gcloud redis instances delete` as a fallback in case the Config Connector controller was not running when resources were deleted.

## Cost estimate

~$1.17/hr (~$28/day) while running with 2 cells at the shipped `starter` tier. Full-HA `production` tier is roughly double that. Teardown after testing to avoid charges.

| Component | Per cell | 2 cells |
|-----------|----------|---------|
| GKE cluster (shared) | — | ~$0.10/hr |
| Cloud SQL (Postgres 16, `starter` = non-HA) | ~$0.30/hr | ~$0.60/hr |
| Memorystore Redis persistent | ~$0.10/hr | ~$0.20/hr |
| Memorystore Redis cache | ~$0.10/hr | ~$0.20/hr |
| GCS bucket (Object storage) | ~$0.01/hr | ~$0.02/hr |
| Cloud NAT | — | ~$0.05/hr |
| **Total** | | **~$1.17/hr** |

Cost scales roughly linearly with cell count. The GKE cluster and NAT are shared across all cells.

## Standalone usage

To run this example outside the monorepo:

1. Copy this directory
2. Replace the `"*"` versions in `package.json`'s `dependencies` with real
   published versions of the six `@intentius/chant*` packages. They resolve
   through the monorepo workspace here and will not resolve outside it. (Unlike
   most examples, this one ships no `package.standalone.json`.)
3. `npm install`
4. `cp .env.example .env` — fill in `GCP_PROJECT_ID` and `DOMAIN`
5. Follow the **Deploy workflow** section above

## Related Examples

- `k8s-gke-microservice` — GCP + K8s cross-lexicon pattern (Config Connector + workloads)
- `cockroachdb-multi-region-gke` — Multi-region stateful deployment with 2 lexicons (GCP, K8s)
