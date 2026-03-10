# gcp-gitlab-cells — Real GitLab with Cells Architecture on GKE

## Context

GitLab provides **no tooling** to deploy Cells outside their own SaaS platform. The HTTP Router, Topology Service, and cell-aware Rails code are open source, but there's no deployment guide, Helm chart, or Terraform module for running multi-cell GitLab. This example fills that gap using Chant — 4 lexicons generating all the infrastructure, K8s resources, Helm charts, and CI pipeline to deploy a multi-cell GitLab on GKE.

This example replaces `examples/aws-gitlab-cells` (placeholder app on EKS) with `examples/gcp-gitlab-cells` (real GitLab on GKE with Cells).

### Lexicons Used

| Lexicon | What it generates |
|---------|------------------|
| GCP | GKE cluster, Cloud SQL (per cell), Memorystore Redis (per cell), GCS buckets, VPC, Cloud DNS, KMS, IAM |
| K8s | Namespaces, NetworkPolicies, Secrets, ServiceMonitors |
| Helm | Wrapper chart with `gitlab/gitlab` as dependency, per-cell values |
| GitLab | CI/CD pipeline (infra → system → canary → remaining cells) |

---

## Architecture

```
Cloud DNS: *.gitlab.example.com
     │
     ▼
┌─── GKE Cluster (shared, single region) ─────────────────────────┐
│                                                                   │
│  ┌─── system namespace ────────────────────────────────────────┐  │
│  │  NGINX Ingress Controller (cell router, TLS, PDB)           │  │
│  │  cert-manager (Let's Encrypt ClusterIssuer)                 │  │
│  │  External Secrets Operator (syncs from Secret Manager)      │  │
│  │  GitLab Runner (shared runner fleet)                        │  │
│  │  Prometheus (cell-aware scrape config)                      │  │
│  │  Topology Service (Go, connects to its own Cloud SQL)       │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ┌─── cell-alpha ──────────────┐  ┌─── cell-beta ──────────────┐ │
│  │  GitLab (Helm release)      │  │  GitLab (Helm release)      │ │
│  │    Webservice (Puma)        │  │    Webservice (Puma)        │ │
│  │    PgBouncer (conn pool)    │  │    PgBouncer (conn pool)    │ │
│  │    Sidekiq (queue-isolated) │  │    Sidekiq                  │ │
│  │    Gitaly (PVC-backed)      │  │    Gitaly (PVC-backed)      │ │
│  │    GitLab Shell             │  │    GitLab Shell             │ │
│  │    Registry                 │  │    Registry                 │ │
│  │                             │  │                             │ │
│  │  NetworkPolicy: no cross-   │  │  NetworkPolicy: no cross-   │ │
│  │  cell traffic               │  │  cell traffic               │ │
│  │  ExternalSecrets: PG, Redis │  │  ExternalSecrets: PG, Redis │ │
│  │    root pw, Rails keys      │  │    root pw, Rails keys      │ │
│  └─────────────────────────────┘  └─────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────┘

External (per cell):
  Cloud SQL PostgreSQL ──── cell-alpha: gitlabhq_production (+ 1 read replica)
  Cloud SQL PostgreSQL ──── cell-beta:  gitlabhq_production
  Memorystore Redis ─────── cell-alpha-persistent (queues, shared_state)
  Memorystore Redis ─────── cell-alpha-cache (cache, sessions)
  Memorystore Redis ─────── cell-beta-persistent (queues, shared_state)
  Memorystore Redis ─────── cell-beta-cache (cache, sessions)
  GCS Bucket ────────────── cell-alpha-artifacts
  GCS Bucket ────────────── cell-alpha-registry
  GCS Bucket ────────────── cell-beta-artifacts
  GCS Bucket ────────────── cell-beta-registry
  Secret Manager ──────────  per-cell secrets (PG pw, Redis auth, root pw, Rails keys, SMTP pw)

Global:
  Cloud SQL PostgreSQL ──── topology-service DB
  Cloud DNS ─────────────── *.gitlab.example.com
  KMS Key Ring ──────────── encryption at rest

Note: Single GKE cluster, single region. Multi-region would require
separate clusters with cross-region Cloud SQL replicas — out of scope
for this example but the cell-per-namespace model extends naturally.
```

### GitLab Cells Concept Mapping

| GitLab Concept | Our Implementation |
|----------------|-------------------|
| Cloudflare Worker (HTTP Router) | NGINX Ingress with path/host routing to cells |
| Topology Service (Cloud Spanner) | Topology Service (open source Go) on Cloud SQL PostgreSQL |
| Cell = isolated GitLab instance | GitLab Helm release per K8s namespace |
| Cell-local PostgreSQL | Cloud SQL instance per cell |
| Cell-local Redis | Memorystore instance per cell |
| Cell-local object storage | GCS bucket per cell |
| Separate GCP project per cell | Separate K8s namespace + Workload Identity SA per cell |
| Private Service Connect | K8s NetworkPolicy (no cross-cell traffic) |
| Organization as partition key | Organization routed via Topology Service |
| Phased deployment | Canary cell → remaining cells in pipeline |

---

## Example Structure

```
examples/gcp-gitlab-cells/
├── README.md
├── package.json
├── .env.example
├── src/
│   ├── chant.config.json
│   ├── config.ts                    # Cell configs + shared config
│   ├── gcp/                         # GCP lexicon
│   │   ├── networking.ts            # VPC, subnets, firewall, Cloud NAT
│   │   ├── cluster.ts               # GKE cluster + node pool
│   │   ├── databases.ts             # Cloud SQL per cell + topology svc
│   │   ├── cache.ts                 # Memorystore Redis per cell (2 each: persistent + cache)
│   │   ├── storage.ts               # GCS buckets per cell (artifacts + registry)
│   │   ├── dns.ts                   # Cloud DNS zone + records
│   │   ├── encryption.ts            # KMS key ring + crypto key
│   │   ├── iam.ts                   # Workload Identity SAs per cell
│   │   ├── secrets.ts               # Secret Manager secrets per cell
│   │   └── outputs.ts               # Deployment outputs
│   ├── system/                      # K8s lexicon (shared namespace)
│   │   ├── namespace.ts             # System namespace + quotas
│   │   ├── ingress-controller.ts    # NGINX ingress (cell router, TLS) + PDB
│   │   ├── topology-service.ts      # Deploy Topology Service
│   │   ├── monitoring.ts            # Prometheus (cell-aware) + Grafana
│   │   ├── cert-manager.ts          # cert-manager + Let's Encrypt ClusterIssuer
│   │   ├── external-secrets.ts      # External Secrets Operator + ClusterSecretStore
│   │   └── gitlab-runner.ts         # Shared GitLab Runner fleet
│   ├── cell/                        # K8s lexicon (per-cell resources)
│   │   ├── factory.ts               # Cell factory: namespace, netpol, secrets
│   │   └── index.ts                 # cells.map(createCell) — config-driven fan-out
│   ├── helm/                        # Helm lexicon
│   │   └── gitlab-cell.ts           # Wrapper chart: gitlab/gitlab dependency + values
│   └── pipeline/                    # GitLab lexicon
│       └── index.ts                 # CI pipeline: 9 stages
├── scripts/
│   ├── bootstrap.sh                 # One-time: gcloud creates GKE + Config Connector
│   ├── deploy-cells.sh              # Generate per-cell values, helm install per cell
│   ├── load-outputs.sh              # Read CC outputs, write .env + Secret Manager
│   ├── e2e-test.sh                  # Post-deploy E2E validation (T8)
│   └── teardown.sh                  # Reverse-order teardown (helm → k8s → CC → cluster)
```

---

## Detailed Tasks

### T1. Config (`src/config.ts`)

```typescript
interface CellConfig {
  name: string;
  // Cell identity (required for GitLab Cells)
  cellId: number;             // unique integer per cell (1, 2, 3...)
  sequenceOffset: number;     // unique offset to avoid PK collisions across cells (e.g., 0, 1000000)
  // Cloud SQL
  pgTier: string;             // e.g., "db-custom-4-15360"
  pgDiskSize: number;         // GB
  pgHighAvailability: boolean;
  pgReadReplicas: number;     // 0 = none, 1+ = read replicas for load balancing
  pgBouncerEnabled: boolean;  // PgBouncer for connection pooling (recommended)
  // Webservice
  webserviceReplicas: number; // Puma pods per cell (2+ for production)
  // Memorystore (2 per cell: persistent + cache)
  redisPersistentTier: string;   // "STANDARD_HA" recommended — queues, shared_state
  redisPersistentSizeGb: number;
  redisCacheTier: string;        // "BASIC" ok — cache, sessions (reconstructable)
  redisCacheSizeGb: number;
  // GCS
  bucketLocation: string;     // e.g., "US"
  artifactRetentionDays: number; // lifecycle policy, e.g., 90. 0 = no expiry
  // K8s
  host: string;               // e.g., "alpha.gitlab.example.com"
  cpuQuota: string;           // e.g., "16"
  memoryQuota: string;        // e.g., "32Gi"
  // Deployment
  canary: boolean;
  // Gitaly
  gitalyDiskSizeGb: number;  // PVC size for persistent Git storage
  // Sidekiq
  sidekiqQueues: SidekiqQueueConfig[]; // queue-specific deployments for isolation
}

interface SidekiqQueueConfig {
  name: string;               // e.g., "urgent", "default", "long-running"
  queues: string[];           // e.g., ["post_receive", "pipeline_processing"]
  replicas: number;
  cpuRequest: string;
  memoryRequest: string;
}

interface SharedConfig {
  projectId: string;
  region: string;
  clusterName: string;
  domain: string;             // e.g., "gitlab.example.com"
  gitlabChartVersion: string; // e.g., "8.7.2"
  // Cluster
  machineType: string;        // e.g., "e2-standard-8"
  minNodeCount: number;       // e.g., 3
  maxNodeCount: number;       // e.g., 20
  nodeDiskSizeGb: number;     // e.g., 200
  releaseChannel: string;     // e.g., "REGULAR"
  // Networking
  nodeSubnetCidr: string;     // e.g., "10.0.0.0/20"
  podSubnetCidr: string;      // e.g., "10.4.0.0/14"
  serviceSubnetCidr: string;  // e.g., "10.8.0.0/20"
  // Ingress
  ingressReplicas: number;    // e.g., 2. NGINX controller pods.
  ingressHpaEnabled: boolean; // HPA for ingress controller
  ingressHpaMaxReplicas: number; // e.g., 10
  // SMTP
  smtpAddress: string;        // e.g., "smtp.sendgrid.net"
  smtpPort: number;           // e.g., 587
  smtpUser: string;           // e.g., "apikey"
  smtpDomain: string;         // e.g., "gitlab.example.com"
  // TLS
  letsEncryptEmail: string;   // e.g., "admin@example.com"
  // Runner
  runnerImage: string;        // e.g., "gitlab/gitlab-runner:v17.8"
  runnerReplicas: number;     // e.g., 2
  runnerConcurrency: number;  // e.g., 10
  runnerNodePoolEnabled: boolean; // separate node pool with taints for CI jobs
  runnerNodePoolMachineType: string; // e.g., "e2-standard-4"
  runnerNodePoolMaxCount: number;    // e.g., 10
  // Topology Service
  topologyDbTier: string;     // e.g., "db-custom-1-3840"
  topologyServiceImage: string; // Built from gitlab-org/cells/topology-service source
  // Monitoring
  prometheusRemoteWriteUrl: string; // "" = local only. Set for Cloud Monitoring/Thanos/Grafana Cloud
}
```

All GCP files use `cells.map()` for per-cell resources — adding a cell means adding one entry to `cells[]`, nothing else.

Alpha (production/canary): cellId=1, sequenceOffset=0, webserviceReplicas=3, pgTier `db-custom-4-15360`, 50GB disk, HA=true, 1 read replica, PgBouncer=true, redisPersistent STANDARD_HA 5GB, redisCache STANDARD_HA 2GB, gitalyDisk 100Gi, cpuQuota "16", memoryQuota "32Gi", artifactRetention 90 days, 3 Sidekiq queue groups (urgent/default/long-running), canary=true.

Beta (staging/overflow): cellId=2, sequenceOffset=1000000, webserviceReplicas=2, pgTier `db-custom-2-7680`, 20GB disk, HA=true, 0 read replicas, PgBouncer=true, redisPersistent STANDARD_HA 3GB, redisCache BASIC 1GB, gitalyDisk 50Gi, cpuQuota "8", memoryQuota "16Gi", artifactRetention 30 days, 1 Sidekiq queue group (all queues), canary=false.

Both cells use HA for Cloud SQL, persistent Redis, and PgBouncer. Cache Redis on beta can be BASIC since it's reconstructable.

### T2. GCP Infrastructure (`src/gcp/`)

| # | File | Resources | Composite Used |
|---|------|-----------|----------------|
| T2a | `networking.ts` | VPC + subnets (with GKE secondary ranges for pods/services) + firewall + Cloud NAT + `PrivateService` (VPC peering for Cloud SQL / Memorystore private IP) | `VpcNetwork` + `PrivateService` |
| T2b | `cluster.ts` | GKE cluster + main node pool (workload identity, autoscale) + optional runner node pool (taints, separate machine type) | `GkeCluster` + raw `NodePool` |
| T2c | `databases.ts` | `cells.map()` → Cloud SQL per cell (POSTGRES_16, optional read replicas) + topology svc | `CloudSqlInstance` (×N+1), `SQLInstance` (read replicas) |
| T2d | `cache.ts` | `cells.map()` → 2 Redis per cell (persistent + cache) | `MemorystoreInstance` (×2N) |
| T2e | `storage.ts` | `cells.map()` → 2 GCS buckets per cell (artifacts + registry). Artifacts bucket has lifecycle policy (delete after `artifactRetentionDays`, nearline after 30 days). | `GcsBucket` (×2N) |
| T2f | `dns.ts` | Cloud DNS zone + wildcard record | `DNSZone` |
| T2g | `encryption.ts` | KMS key ring + crypto key | `KMSEncryption` |
| T2h | `iam.ts` | `cells.map()` → Workload Identity SA per cell (bucket-scoped `objectAdmin`, not project-level) + ESO SA (`secretAccessor`) + cert-manager SA (`dns.admin`) | `GCPServiceAccount` + `IAMPolicyMember` |
| T2i | `secrets.ts` | `cells.map()` → Secret Manager secrets per cell (PG pw, Redis auth, root pw, Rails secrets multi-key YAML blob, SMTP pw). Rails secret must contain `secret_key_base`, `db_key_base`, `otp_key_base`, `encrypted_settings_key_base` as a YAML document. Cloud SQL password flow: Config Connector creates instance → CC stores credentials in K8s Secret → `load-outputs.sh` reads password → writes to Secret Manager. | `SecretManagerSecret` + `SecretManagerSecretVersion` |
| T2j | `outputs.ts` | Export config references (Cloud SQL IPs, Redis hosts, GCS bucket names) for cross-lexicon use | |

### T3. System Namespace (`src/system/`)

| # | File | Resources | Notes |
|---|------|-----------|-------|
| T3a | `namespace.ts` | Namespace + ResourceQuota (32 CPU, 64Gi) | `NamespaceEnv` composite |
| T3b | `ingress-controller.ts` | NGINX Ingress Deployment + Service + PDB + HPA (if `ingressHpaEnabled`) | Cell router. Routes by host header. TLS termination via cert-manager certs. HPA scales from `ingressReplicas` to `ingressHpaMaxReplicas` on CPU/connections. |
| T3c | `topology-service.ts` | Deployment + Service + ConfigMap for Topology Service | Deploy the open-source Go binary from `gitlab-org/cells/topology-service`. Must be built from source (`gcloud builds submit` or local `docker build`). Add `topologyServiceImage` to SharedConfig. Config points to its Cloud SQL. |
| T3d | `monitoring.ts` | Prometheus (cell-aware ConfigMap) + Grafana | Scrape cell namespaces with `cell` label relabeling. Optional `remote_write` to `prometheusRemoteWriteUrl` for scaling beyond single-instance Prometheus (Cloud Monitoring, Thanos, Grafana Cloud). |
| T3e | `cert-manager.ts` | cert-manager Deployment + ClusterIssuer (Let's Encrypt) | TLS for all ingress. ClusterIssuer with ACME DNS-01 solver (Cloud DNS). HTTP-01 can't issue wildcards. cert-manager SA needs `roles/dns.admin`. |
| T3f | `external-secrets.ts` | External Secrets Operator Deployment + ClusterSecretStore (GCP Secret Manager) | Syncs secrets from GCP Secret Manager → K8s Secrets. Requires Workload Identity. |
| T3g | `gitlab-runner.ts` | GitLab Runner Deployment + ConfigMap + ServiceAccount | Shared runner fleet. Registers with canary cell. Config for Kubernetes executor. |

### T4. Cell Resources (`src/cell/`)

| # | File | Resources | Notes |
|---|------|-----------|-------|
| T4a | `factory.ts` | Per cell: Namespace, ResourceQuota, LimitRange, default-deny ingress, egress deny (allow DNS + GCP APIs + Cloud SQL/Redis private IPs), Workload Identity SA binding, ExternalSecret CRs (PG pw, Redis auth, root pw, Rails secrets blob, SMTP pw — synced from Secret Manager). CRs created via `createResource()` from core (no `CustomResource` class — see note below). Pod Security label `baseline`. | K8s lexicon resources |
| T4b | `index.ts` | `cells.map(createCell)` — config-driven fan-out, exports all cell resources | |

### T5. Helm Chart (`src/helm/`)

| # | File | Output | Notes |
|---|------|--------|-------|
| T5a | `gitlab-cell.ts` | Wrapper Helm chart `gitlab-cell/` | `Chart` + `HelmDependency` on `gitlab/gitlab`. `Values` with cell-specific overrides: external PG, external Redis, GCS object storage, domain, ingress class. |

The following shows the rendered Helm output. In Chant source, `{{ .Values.x }}` is written as `v("x")`.

```yaml
# Chart.yaml
dependencies:
  - name: gitlab
    version: "8.7.2"
    repository: "https://charts.gitlab.io"

# values.yaml — cell-specific inputs (overridden per cell)
cellDomain: ""
cellName: ""
cellId: 0
sequenceOffset: 0
pgHost: ""
pgReadReplicaHost: ""       # "" = no read replica
pgBouncerEnabled: true
redisPersistentHost: ""
redisCacheHost: ""
projectId: ""
artifactsBucket: ""
registryBucket: ""
smtpAddress: ""
smtpPort: 587
smtpUser: ""
smtpDomain: ""
gitalyDiskSize: "50Gi"
webserviceReplicas: 2

global:
  hosts:
    domain: {{ .Values.cellDomain }}
    https: true

  # ── Cells identity (REQUIRED for multi-cell) ───────────────
  cells:
    enabled: true
    id: {{ .Values.cellId }}
    topology_service:
      address: "topology-service.system.svc:8080"
    sequence_offset: {{ .Values.sequenceOffset }}

  # ── TLS via cert-manager ───────────────────────────────────
  ingress:
    configureCertmanager: false
    tls:
      enabled: true
      secretName: gitlab-tls
    annotations:
      cert-manager.io/cluster-issuer: letsencrypt-prod

  # ── External PostgreSQL ────────────────────────────────────
  psql:
    host: {{ .Values.pgHost }}
    port: 5432
    database: gitlabhq_production
    password:
      secret: gitlab-db-password
      key: password
    # PgBouncer (GitLab chart manages PgBouncer pods in-namespace)
    pgbouncer: {{ .Values.pgBouncerEnabled }}
    # Read replica load balancing: when pgReadReplicaHost is non-empty,
    # load-outputs.sh adds a load_balancing block to values-<cell>.yaml:
    #   load_balancing: { hosts: [<ip>], max_replication_lag_size: 8388608, check_interval: 10 }

  # ── External Redis (split persistent + cache) ──────────────
  redis:
    host: {{ .Values.redisPersistentHost }}
    auth:
      enabled: true
      secret: gitlab-redis-password
      key: password
    cache:
      host: {{ .Values.redisCacheHost }}
      password:
        enabled: true
        secret: gitlab-redis-cache-password
        key: password
    sharedState:
      host: {{ .Values.redisPersistentHost }}
      password:
        enabled: true
        secret: gitlab-redis-password
        key: password
    queues:
      host: {{ .Values.redisPersistentHost }}
      password:
        enabled: true
        secret: gitlab-redis-password
        key: password
    actioncable:
      host: {{ .Values.redisCacheHost }}
      password:
        enabled: true
        secret: gitlab-redis-cache-password
        key: password

  # ── Initial root password + Rails secrets ───────────────────
  initialRootPassword:
    secret: gitlab-root-password
    key: password
  railsSecrets:
    secret: gitlab-rails-secret   # Must contain secret_key_base, db_key_base,
                                  # otp_key_base, encrypted_settings_key_base

  # ── Object storage (GCS via Workload Identity) ─────────────
  minio:
    enabled: false
  appConfig:
    object_store:
      enabled: true
      connection:
        provider: Google
        google_project: {{ .Values.projectId }}
        google_application_default: true  # Workload Identity — no key file
    artifacts:
      bucket: {{ .Values.artifactsBucket }}
    uploads:
      bucket: {{ .Values.artifactsBucket }}
    lfs:
      bucket: {{ .Values.artifactsBucket }}
    packages:
      bucket: {{ .Values.artifactsBucket }}

  # ── SMTP ───────────────────────────────────────────────────
  smtp:
    enabled: true
    address: {{ .Values.smtpAddress }}
    port: {{ .Values.smtpPort }}
    user_name: {{ .Values.smtpUser }}
    domain: {{ .Values.smtpDomain }}
    authentication: "plain"
    starttls_auto: true
    password:
      secret: gitlab-smtp-password
      key: password

  # ── Container registry ─────────────────────────────────────
  registry:
    enabled: true
    storage:
      secret: registry-storage
      key: config

# ── GitLab component config ──────────────────────────────────
gitlab:
  webservice:
    replicas: {{ .Values.webserviceReplicas }}
  gitaly:
    persistence:
      enabled: true
      size: {{ .Values.gitalyDiskSize }}
      storageClass: standard-rwo
  # Sidekiq queue isolation (map format, one entry per queue group)
  # Generated from cell.sidekiqQueues at build time
  sidekiq:
    pods:
      urgent:
        queues: post_receive,pipeline_processing
        replicas: 2
        resources:
          requests: { cpu: 500m, memory: 1Gi }
      default:
        queues: default,mailers
        replicas: 2
        resources:
          requests: { cpu: 250m, memory: 512Mi }
      long-running:
        queues: repository_import,pipeline_schedule
        replicas: 1
        resources:
          requests: { cpu: 250m, memory: 1Gi }
  # PgBouncer pool config (only applies when pgbouncer: true above)
  pgbouncer:
    default_pool_size: 20
    min_pool_size: 5
    max_client_conn: 150

# ── Disable bundled PostgreSQL, Redis, MinIO ──────────────────
postgresql:
  install: false
redis:
  install: false

# Note: For large scale, consider Praefect (Gitaly Cluster) for Git storage HA.
# The config can be extended with praefectEnabled/praefectReplicas when needed.
```

### T6. Pipeline (`src/pipeline/index.ts`)

| Stage | Job | Details |
|-------|-----|---------|
| `infra` | `deploy-gcp` | `kubectl apply -f config.yaml` — Config Connector creates Cloud SQL, Redis, GCS, DNS, KMS, IAM, Secret Manager. (GKE cluster pre-exists via bootstrap.) |
| `system` | `deploy-system` | Install cert-manager + ESO (via kubectl/helm in gcloud-sdk image). Apply system K8s resources. Wait for ingress controller. |
| `validate` | `validate-cells` | `helm diff` per cell (dry-run preview). Uses helm image. |
| `deploy-canary` | `deploy-cell-<canary>` | `helm upgrade --install gitlab-cell-<name>` for canary cells. Wait for `gitlab-cell-<name>-webservice-default` rollout. First deploy runs `db:migrate` (~20 min). `--timeout=900s`. |
| `deploy-remaining` | `deploy-cell-*` (matrix) | Same for non-canary cells. Depends on canary success. |
| `register-runners` | `register-runners` | Register runners with canary cell after GitLab is up. Create runner token via `gitlab-rails runner`, configure runner secret. |
| `smoke-test` | `e2e-test` | Run `scripts/e2e-test.sh` — validates 10 areas. Config-driven cell iteration (no hardcoded names). |
| `backup` | `backup-gitaly` (scheduled) | `gitaly-backup create` per cell → GCS. Cron-triggered. Cloud SQL backups automatic. |
| `migrate-org` | `migrate-org` (manual) | Update Topology Service to reassign org to target cell. |

### T7. README

Content sections:

- Title + description (4 lexicons, GitLab Cells on GKE)
- Architecture diagram (from PLAN.md)
- GitLab Cells concept mapping table
- GCP Well-Architected alignment
- Prerequisites (gcloud CLI, kubectl, helm, jq)
- Deploy instructions
- Pipeline stages (9-stage)
- Outputs table (4 output files)
- Source file tables (per layer)
- Teardown
- Related examples

#### Skills table

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

> **Using Claude Code?** Ask your agent to deploy, passing your domain:
>
> ```
> Deploy the gcp-gitlab-cells example. My domain is gitlab.mycompany.com.
> ```
>
> Your agent will use `chant-gke`, `chant-helm`, and `chant-gitlab` to walk through the full standup.

#### Skills guide

This is a 4-lexicon example (GCP, K8s, Helm, GitLab). Each deployment phase maps to specific skills.

##### `chant-gke` — primary entry point

The end-to-end GKE skill covers infrastructure provisioning via Config Connector and K8s workload deployment. This is the skill your agent invokes first — it handles bootstrap, VPC, cluster, and cross-lexicon value flow.

##### `chant-gcp-security` — security patterns

Covers the security stack used across the example:

| Pattern | Files | What it does |
|---------|-------|--------------|
| Workload Identity | `iam.ts`, `factory.ts` | Per-cell SA with GKE WI binding, bucket-scoped objectAdmin |
| KMS encryption | `encryption.ts` | Key ring + crypto key for encryption at rest |
| Secret Manager | `secrets.ts` | Per-cell secrets synced to K8s via External Secrets Operator |
| IAM least-privilege | `iam.ts` | Bucket-scoped objectAdmin (not project-level), dns.admin for cert-manager |

##### `chant-k8s` — core composites and operations

Comprehensive reference for composites used in the system and cell namespaces:

| Composite | Used in | What it does |
|-----------|---------|--------------|
| `NamespaceEnv` | `namespace.ts`, `factory.ts` | Namespace + ResourceQuota + LimitRange + PSS labels |
| `WorkloadIdentityServiceAccount` | `factory.ts` | Cell SA with GKE Workload Identity binding |

Includes the **"Choosing the Right Composite" decision tree**, hardening options, and troubleshooting workflows.

##### `chant-k8s-gke` — GKE-specific composites

Covers the GKE-specific composites used in this example:

| Composite | File | What it does |
|-----------|------|--------------|
| `WorkloadIdentityServiceAccount` | `factory.ts` | GKE WI setup, `iam.gke.io/gcp-service-account` annotation |
| `GcePdStorageClass` | (Gitaly PVC) | GCE PD CSI provisioner, standard-rwo |

##### `chant-k8s-deployment-strategies` — deployment patterns

Covers canary deployment (deploy canary cell first, validate, fan out), stateful workloads (Gitaly StatefulSet with PVC), and RBAC patterns.

##### `chant-k8s-security` — security hardening

Covers pod security standards (`baseline` enforcement on cell namespaces), network policies (default-deny ingress/egress per cell), and secrets management (ExternalSecrets syncing from GCP Secret Manager).

##### `chant-k8s-patterns` — advanced patterns

Patterns used and available to extend:

- **Network isolation** — default-deny ingress + egress-deny NetworkPolicies per cell
- **TLS with cert-manager** — Let's Encrypt ClusterIssuer, DNS-01 solver for wildcard certs
- **Prometheus monitoring** — cell-aware scrape config with label relabeling, optional remote_write
- **Sidecars** — extend with Envoy proxy or log forwarder via `SidecarApp`

##### `chant-helm` + `chant-helm-chart-patterns` — wrapper chart

Covers the Helm lifecycle and the wrapper chart pattern used here:

| Pattern | File | What it does |
|---------|------|--------------|
| Wrapper chart | `gitlab-cell.ts` | `Chart` + `HelmDependency` on `gitlab/gitlab` |
| Per-cell values | `deploy-cells.sh` | `helm upgrade --install` with `-f values-<cell>.yaml` |
| Dependency management | `Chart.yaml` | Charts.gitlab.io repository, version-pinned |

`chant-helm-chart-security-patterns` covers RBAC, PSS, and network policies applied to Helm releases.

##### `chant-gitlab` + `gitlab-ci-patterns` — CI pipeline

Covers the 9-stage pipeline with multi-stage deployment patterns:

- **Canary deployment** — deploy canary cell first, validate, then deploy remaining
- **Matrix fan-out** — `parallel: matrix` for non-canary cells
- **Scheduled jobs** — gitaly-backup on cron schedule
- **Manual jobs** — org migration via Topology Service

#### Skill workflow

```
1. chant-gke                                   "Bootstrap GKE + Config Connector"
   │                                            → VPC, cluster, CC addon, Workload Identity
   │
2. chant-gcp + chant-gcp-security              "Deploy GCP infrastructure"
   │                                            → Cloud SQL, Redis, GCS, DNS, KMS, IAM, secrets
   │
3. chant-k8s                                   "Deploy system + cell namespaces"
   │                                            → NamespaceEnv, NetworkPolicy, ExternalSecrets
   │
4. chant-helm + chant-helm-chart-patterns      "Build and deploy wrapper chart"
   │                                            → Chart, values, helm upgrade --install per cell
   │
5. chant-gitlab + gitlab-ci-patterns           "Generate CI pipeline"
   │                                            → 9-stage pipeline, canary-first, matrix fan-out
   │
6. chant-k8s-patterns                          "Network isolation + TLS + monitoring"
   │                                            → NetworkPolicy, cert-manager, Prometheus
   │
7. chant-gcp-security                          "Verify security posture"
                                                → WI bindings, KMS, IAM scope, secrets sync
```

#### Agent-guided standup

Ask your agent to deploy and it will walk through these phases:

```
Deploy the gcp-gitlab-cells example. My domain is gitlab.mycompany.com.
```

Your agent will:

1. **Bootstrap** — `npm run bootstrap` creates GKE cluster via gcloud, enables Config Connector, binds CC service account
2. **Build** — `npm run build` generates 4 artifacts (Config Connector manifest, K8s manifest, Helm chart, GitLab CI pipeline)
3. **Deploy infrastructure** — `npm run deploy-infra` applies Config Connector resources (Cloud SQL, Redis, GCS, DNS, KMS, IAM, secrets)
4. **Load outputs** — `npm run load-outputs` reads CC outputs (Cloud SQL IPs, Redis hosts, bucket names), writes `.env` and per-cell values files
5. **Deploy system** — `npm run apply:system` installs NGINX ingress, cert-manager, ESO, Topology Service, Prometheus, Grafana
6. **Deploy cells** — `npm run apply:cells && npm run deploy-cells` creates cell namespaces and runs `helm upgrade --install` per cell (canary first)
7. **Verify** — `bash scripts/e2e-test.sh` validates all 10 areas (infra health, system namespace, per-cell GitLab, git operations, registry, cell isolation, topology routing, runner, backup)

Other useful prompts:

```
Build and lint the gcp-gitlab-cells example locally.
```

```
Tear down the gcp-gitlab-cells example.
```

```
Add a new cell to the gcp-gitlab-cells example.
```

```
Upgrade GitLab chart version in gcp-gitlab-cells.
```

### T8. E2E Test (`scripts/e2e-test.sh`)

Post-deploy validation script that verifies the complete stack. Run manually or as pipeline stage.

| Area | What it validates |
|------|-------------------|
| **Infra health** | All Config Connector resources `Ready`. Cloud SQL instances accepting connections. Memorystore reachable. GCS buckets exist with correct lifecycle policies. |
| **System namespace** | Ingress controller running + has external IP. cert-manager pods ready. ESO pods ready + ClusterSecretStore synced. Runner pods ready. Topology Service responding on `/healthz`. Prometheus scraping cell targets. |
| **Per-cell GitLab** | For each cell: Webservice pods running. Gitaly pods running with PVC bound. `curl https://<cell.host>/-/health` returns 200. `curl https://<cell.host>/-/readiness` returns 200. TLS certificate valid (not self-signed). |
| **Git operations** | Create project via API on canary cell. `git clone` via HTTPS. `git push` a commit. Verify commit appears in API. |
| **Container registry** | `docker login <cell.host>`. `docker push` a test image. `docker pull` it back. |
| **Cell isolation** | From pod in cell-alpha, `curl cell-beta.<svc>` must fail (NetworkPolicy). Verify each cell has its own DB (query `SELECT current_database()`). Verify each cell has its own Redis (`INFO keyspace`). |
| **Topology routing** | Query Topology Service API for org→cell mapping. Verify ingress routes org to correct cell. |
| **Runner** | Trigger CI pipeline on canary cell. Wait for job to start. Verify runner pod created in correct namespace. |
| **Backup** | Trigger `gitaly-backup create` for canary cell. Verify backup artifact in GCS bucket. |
| **Teardown** (optional) | `helm uninstall` all cells. `kubectl delete -f k8s.yaml`. `kubectl delete -f config.yaml`. Verify resources deleted. |

Exit codes: 0 = all pass, 1 = any failure (with summary of what failed).


---

## What GitLab Open-Sources (but doesn't deploy)

GitLab Cells is **architecturally designed** but **operationally locked to GitLab.com**. The docs explicitly state: *"This feature is not available for GitLab Self-Managed or GitLab Dedicated."* The open source code has building blocks but **zero deployment tooling** for running Cells yourself.

| Component | Repo / Location | What exists | What's missing |
|-----------|----------------|-------------|----------------|
| HTTP Router | `gitlab-org/cells/http-router` | Cloudflare Worker that routes requests to cells | Can't run on K8s. No container image, no Helm chart, no deployment guide. |
| Topology Service | `gitlab-org/cells/topology-service` | Go service tracking cell membership + org routing | No published container image, no deployment guide, no config docs. |
| Rails Cells support | Main GitLab repo | DB schemas split (`gitlab_main_org` vs `gitlab_shared_org`). Config flag `cells.enabled`. Sequence offset support. | Undocumented for self-managed. Global uniqueness (Claim Service) not available. |
| Cells config in Helm | `gitlab/gitlab` chart | Basic config: cell ID, topology service address, mTLS certs. | No multi-cell orchestration. Single-cell-only. |

## What We Build (the gap this example fills)

This example is the **first self-managed Cells deployment toolkit** — it bridges the gap between "the code supports Cells" and "you can actually deploy Cells."

| Gap | What we build |
|-----|---------------|
| **No multi-cell deployment tooling** — no Terraform, no umbrella chart, no CI template | 4 lexicons generate all infra (GCP), K8s resources, Helm chart, and CI pipeline. |
| **No HTTP Router for K8s** — production uses Cloudflare Worker | NGINX Ingress with host-based routing + TLS via cert-manager. Simpler but proves the pattern. |
| **No Topology Service deployment** — code exists but no image/chart/config | Raw K8s Deployment + Service + ConfigMap on its own Cloud SQL (PostgreSQL mode). |
| **No per-cell infra provisioning** — no tooling for "each cell gets its own PG, Redis, object storage" | `CloudSqlInstance` ×3, `MemorystoreInstance` ×4, `GcsBucket` ×4 composites. Per-cell Secret Manager secrets. |
| **No cell isolation patterns** — no NetworkPolicy, namespace, or Workload Identity guidance | Cell factory: `NamespaceEnv` + default-deny + egress-deny + `WorkloadIdentityServiceAccount`. |
| **No phased/canary deployment** — no CI template for canary cell → remaining cells | 9-stage GitLab CI pipeline with canary-first, matrix fan-out, backup, manual org migration. |
| **Cloud SQL private connectivity** — requires VPC peering setup | `PrivateService` composite for VPC peering + private services access. |
| **GitLab chart has 100+ values** — no minimal external-services config documented | Wrapper Helm chart with production-complete values: external PG, split Redis (persistent + cache), GCS, TLS, SMTP, registry, Gitaly PVC, root password, Rails secrets. |
| **No secrets management** — no guidance on storing DB passwords, Redis auth, root password | GCP Secret Manager (via Config Connector) + External Secrets Operator syncing to K8s Secrets. |
| **No TLS** — self-managed GitLab needs cert provisioning | cert-manager with Let's Encrypt ClusterIssuer. NGINX ingress terminates TLS. |
| **No SMTP** — GitLab requires outbound email for user onboarding, notifications, password resets | SMTP config in Helm values. SMTP password in Secret Manager. |
| **No CI runners** — GitLab without runners can't run pipelines | Shared GitLab Runner deployment in system namespace with Kubernetes executor. |
| **No container registry** — GitLab's built-in registry needs GCS storage config | Per-cell registry GCS bucket + Helm registry config with Workload Identity. |
| **No backup strategy** — Cloud SQL auto-backup exists but Gitaly has no backup | Scheduled `gitaly-backup` pipeline job per cell → GCS. Cloud SQL backups automatic. GCS versioning enabled. |
| **No connection pooling** — GitLab opens many PG connections per pod | PgBouncer enabled via `global.psql.pgbouncer` in Helm values. Configurable pool sizes. |
| **No Sidekiq isolation** — all queues in one process causes head-of-line blocking | Queue-isolated Sidekiq pods via `gitlab.sidekiq.pods`. Urgent, default, and long-running queues separated. |
| **No read replica support** — all reads hit primary database | Cloud SQL read replicas + `global.psql.load_balancing` for read distribution. Configurable per cell. |
| **No ingress scaling** — single NGINX pod is a bottleneck | HPA on NGINX ingress controller. Scales from `ingressReplicas` to `ingressHpaMaxReplicas`. |
| **No artifact lifecycle** — storage grows unbounded | GCS lifecycle policies on artifact buckets: delete after `artifactRetentionDays`, nearline transition after 30 days. |
| **No runner isolation** — CI jobs compete with GitLab workloads | Optional dedicated runner node pool with taints (`gitlab.com/runner-only`). Runners tolerate taint, GitLab pods don't. |
| **No CDN** — static assets served directly from GitLab pods | Out of scope for K8s/Helm layer. Recommend Cloud CDN in front of NGINX ingress (manual GCP console/CLI setup, or future `CDNBackendBucket` composite). Document as scaling note. |
| **No monitoring scale-out** — single Prometheus instance | Optional `remote_write` to Cloud Monitoring, Thanos, or Grafana Cloud via `prometheusRemoteWriteUrl`. |
| **No Gitaly HA path** — single Gitaly is SPOF for Git storage | Documented path to Praefect (Gitaly Cluster) with config extensibility. Not default but ready to enable. |
| **No E2E validation** — deploy-and-pray | `scripts/e2e-test.sh` validates 10 areas post-deploy. Runs as pipeline stage before backup. |

---

## Execution Order

### Phase 0: Bootstrap (one-time, manual)
`scripts/bootstrap.sh` — creates GKE cluster via `gcloud`, enables Config Connector addon, sets up CC service account + Workload Identity binding. Pattern: `k8s-gke-microservice/scripts/bootstrap.sh`.

### Phase 1: Scaffold
- Create example directory structure
- `package.json` with 4 lexicon dependencies
- `config.ts` with cell definitions

### Phase 2: GCP Infrastructure (Config Connector)
T2a (VPC) → T2b (GKE node pools) → T2c (databases + read replicas) → T2d (cache) → T2e (storage) → T2f (DNS) → T2g (KMS) → T2h (IAM) → T2i (secrets) → T2j (outputs)

Note: VPC and GKE cluster are created by bootstrap script. Config Connector adopts them and manages additional resources (node pools, subnets, NAT). Cloud SQL, Redis, GCS, DNS, KMS, IAM, Secret Manager are created by Config Connector.

### Phase 3: K8s Resources
T3a (system namespace) → T3b (ingress) → T3c (topology service) → T3d (monitoring) → T3e (cert-manager) → T3f (external-secrets) → T3g (runner — deployed after cells, registered post-deploy) → T4 (cell factory + index)

### Phase 4: Helm Chart
T5 (wrapper chart with gitlab/gitlab dependency)

### Phase 5: Pipeline
T6 (GitLab CI)

### Phase 6: Scripts
T8 (bootstrap, deploy-cells, load-outputs, e2e-test, teardown)

### Phase 7: Documentation
T7 (README)

---

## Composites to Reuse

| Composite | Source | Usage |
|-----------|--------|-------|
| `VpcNetwork` | `lexicons/gcp/src/composites/vpc-network.ts` | VPC + subnets + firewall + Cloud NAT |
| `GkeCluster` | `lexicons/gcp/src/composites/gke-cluster.ts` | GKE cluster + node pool |
| `CloudSqlInstance` | `lexicons/gcp/src/composites/cloud-sql-instance.ts` | PostgreSQL per cell + topology svc |
| `MemorystoreInstance` | `lexicons/gcp/src/composites/memorystore-instance.ts` | Redis per cell (NEW) |
| `GcsBucket` | `lexicons/gcp/src/composites/gcs-bucket.ts` | Object storage per cell |
| `DNSZone` | `lexicons/gcp/src/composites/dns-zone.ts` | Cloud DNS zone + records (NEW) |
| `KMSEncryption` | `lexicons/gcp/src/composites/kms-encryption.ts` | KMS key ring + crypto key (NEW) |
| `PrivateService` | `lexicons/gcp/src/composites/private-service.ts` | Cloud SQL private IP VPC peering |
| `NamespaceEnv` | `lexicons/k8s/src/composites/namespace-env.ts` | Namespace + quota per cell |
| `WorkloadIdentityServiceAccount` | `lexicons/k8s/src/composites/` | Cell SA with GKE Workload Identity binding |
| `Chart` + `HelmDependency` + `Values` | `lexicons/helm/src/resources.ts` | Wrapper chart for gitlab/gitlab |

## Cost Estimate (us-central1, 2 cells)

Monthly estimates based on default config (alpha + beta). Prices are on-demand, us-central1.

| Component | Spec | Monthly |
|-----------|------|---------|
| GKE control plane | Standard tier | $73 |
| GKE nodes | 3× e2-standard-8 (min) | $585 |
| Cloud SQL (alpha) | db-custom-4-15360, HA, 50GB SSD | $410 |
| Cloud SQL (beta) | db-custom-2-7680, HA, 20GB SSD | $200 |
| Cloud SQL (topology) | db-custom-1-3840, 10GB SSD | $50 |
| Redis (alpha persistent) | STANDARD_HA, 5GB | $180 |
| Redis (alpha cache) | STANDARD_HA, 2GB | $72 |
| Redis (beta persistent) | STANDARD_HA, 3GB | $108 |
| Redis (beta cache) | BASIC, 1GB | $36 |
| Cloud NAT | 1 gateway | $32 |
| GCS | 4 buckets, minimal data | $5 |
| Cloud DNS + KMS + Secret Manager | | $5 |
| Cloud SQL read replica (alpha) | db-custom-4-15360 (1 replica) | $200 |
| Runner node pool (optional) | 2× e2-standard-4 (autoscale 0–10) | $130 |
| **Total (2 cells, with scaling)** | | **~$2,086/mo** |

### Scaling notes

- **Per additional cell:** ~$400–600/mo depending on Cloud SQL tier and Redis sizing
- **Node autoscaling:** 3–20 nodes. At 20× e2-standard-8 = ~$3,900/mo compute
- **Committed use discounts:** 1-year CUD saves ~30% on compute, 3-year saves ~55%
- **Cloud SQL CUD:** 1-year saves ~25% on database instances
- **Preemptible/Spot nodes:** Saves ~60-80% on node pool cost for non-critical workloads. Not recommended for Gitaly nodes.
- **GCS cost:** Scales with data. At 1TB artifacts + 500GB registry per cell ≈ $30/cell/mo
- **Egress:** Not included. Internal GCP traffic is free; internet egress is $0.12/GB

### Cost reduction options (configurable)

| Option | Savings | Config change |
|--------|---------|---------------|
| Beta: `pgHighAvailability: false` | ~$100/mo | Acceptable for non-production cell |
| Beta: `redisPersistentTier: "BASIC"` | ~$54/mo | Risk: no automatic failover |
| Smaller nodes: `e2-standard-4` | ~$290/mo | May limit pod density |
| Fewer min nodes: `minNodeCount: 2` | ~$195/mo | Reduced HA for node failures |
| Topology DB: `db-f1-micro` | ~$40/mo | Shared-core, fine for low-traffic topology svc |

---

## Verification

### Local (no GCP required)

1. `cd examples/gcp-gitlab-cells && npm run build` — all 4 lexicons build
2. `npm run lint` — no violations
3. GCP output contains: GKE cluster, Cloud SQL (×3 + read replicas), Memorystore (×4), GCS buckets (×4 with lifecycle), VPC, DNS, KMS, IAM, Secret Manager secrets, runner node pool
4. K8s output contains: system namespace (ingress + HPA, cert-manager, ESO, runner, topology svc, monitoring with remote_write), per-cell namespaces with NetworkPolicies and ExternalSecrets
5. Helm output contains: `gitlab-cell/` chart directory with Chart.yaml (gitlab dependency), values.yaml with full production config (TLS, split Redis, PgBouncer, Sidekiq queue isolation, read replica load balancing, SMTP, registry, Gitaly PVC, secrets refs)
6. GitLab CI output contains: 9-stage pipeline with canary deployment, E2E smoke test, backup job, and manual migration job

### E2E (requires GCP project)

7. `npm run deploy` — full stack deployment (30+ min)
8. `bash scripts/e2e-test.sh` — validates all 10 areas (infra health, system namespace, per-cell GitLab, git operations, container registry, cell isolation, topology routing, runner, backup, optional teardown)
9. `npm run teardown` — clean up all resources

---

## Operational Notes

### Scripts

| Script | Purpose |
|--------|---------|
| `bootstrap.sh` | One-time GKE cluster creation via `gcloud`. Enables Config Connector addon, creates CC service account with `editor`, `iam.securityAdmin`, `dns.admin` roles, binds via Workload Identity. Pattern: `k8s-gke-microservice/scripts/bootstrap.sh`. |
| `load-outputs.sh` | Reads Config Connector outputs (Cloud SQL private IPs, Redis hosts, ingress LoadBalancer IP). Writes to `.env` and updates Secret Manager secrets via `gcloud secrets versions add`. Generates per-cell Helm values files (`values-alpha.yaml`, `values-beta.yaml`). |
| `deploy-cells.sh` | Iterates cells from config. Runs `helm upgrade --install gitlab-cell-<name> ./gitlab-cell/ -n cell-<name> -f values-<name>.yaml --wait --timeout=900s` per cell. Canary cells first, then remaining. |
| `e2e-test.sh` | Post-deploy validation (10 areas). Config-driven cell iteration via `kubectl get ns -l app.kubernetes.io/part-of=cells`. Exit 0 = all pass, 1 = any failure. |
| `teardown.sh` | Reverse-order: `helm uninstall` all cells → `kubectl delete -f k8s.yaml` → `kubectl delete -f config.yaml` (Config Connector deletes GCP resources) → `gcloud container clusters delete` (optional). |

### Upgrade / Rollback

1. Update `gitlabChartVersion` in config.ts
2. `npm run build` to regenerate chart
3. Deploy canary cell first: `helm upgrade gitlab-cell-alpha ...`
4. Validate canary: `curl https://alpha.gitlab.example.com/-/health`
5. If canary fails: `helm rollback gitlab-cell-alpha 0`
6. If canary passes: deploy remaining cells

### Backup / Restore

- **Cloud SQL**: Automatic daily backups (configured via Config Connector). Point-in-time recovery available.
- **Gitaly**: Scheduled `gitaly-backup create` pipeline job → GCS. Restore: `gitaly-backup restore --path gs://...`.
- **GCS**: Versioning enabled on all buckets. Accidental deletes recoverable via `gsutil cp gs://bucket/object#version .`.
- **Secrets**: Secret Manager maintains version history. Rollback: `gcloud secrets versions enable <version>`.

### Cell Decommissioning

1. Migrate all orgs from cell via Topology Service (`topology-cli migrate-org`)
2. Verify cell has zero active projects/users
3. `helm uninstall gitlab-cell-<name> -n cell-<name>`
4. `kubectl delete ns cell-<name>`
5. Delete Config Connector resources (Cloud SQL, Redis, GCS buckets)
6. Remove cell entry from `cells[]` in config.ts
7. `npm run build` to update pipeline and remaining configs

### Recommended Add-ons (out of scope)

- **Logging**: `GkeFluentBitAgent` composite (see `k8s-gke-microservice`). Ships container logs to Cloud Logging.
- **Alerting**: Prometheus AlertManager with PagerDuty/Slack receivers. Configure via `alertmanager.yml` ConfigMap.
- **Pod Security Standards**: Cell namespaces should have `pod-security.kubernetes.io/enforce: baseline` label (included in factory.ts).
- **Gitaly node affinity**: Production should set `podAntiAffinity` to spread Gitaly across nodes. Configurable via `gitlab.gitaly.affinity` Helm values.
- **System namespace resource requests**: NGINX (500m/512Mi), topology service (250m/256Mi), Prometheus (1/2Gi), Grafana (250m/256Mi) — set in respective Deployment specs.

### Pod Count Estimate

| Namespace | Pods | Notes |
|-----------|------|-------|
| system | ~12 | NGINX (2-10), cert-manager (3), ESO (1-3), runner (2+), Prometheus (1), Grafana (1), topology svc (1) |
| cell-alpha | ~14 | webservice (3), sidekiq (5), gitaly (1), gitlab-shell (2), registry (2), pgbouncer (1) |
| cell-beta | ~10 | webservice (2), sidekiq (2), gitaly (1), gitlab-shell (1), registry (1), pgbouncer (1), toolbox (1), migrations (1) |
| **Total** | **~36** | Minimum 3× e2-standard-8 nodes (24 vCPU each = 72 vCPU total). Autoscaler handles growth. |
