# Implementation Roadmap

Concrete implementation plan grounded in actual codebase APIs. See [PLAN.md](./PLAN.md) for the design doc (architecture, gaps, concept mapping).

Reference examples: `aws-gitlab-cells` (same cell pattern, 3 lexicons), `k8s-gke-microservice` (GCP + K8s pattern).

---

## Files to Create (30 files)

### Phase 1: Scaffold (3 files)

#### `package.json`

Pattern: `k8s-gke-microservice/package.json` + `aws-gitlab-cells/package.json`.

```json
{
  "name": "gcp-gitlab-cells-example",
  "version": "0.0.1",
  "type": "module",
  "private": true,
  "scripts": {
    "build": "npm run build:gcp && npm run build:k8s && npm run build:helm && npm run build:gitlab",
    "build:gcp": "chant build src --lexicon gcp -o config.yaml",
    "build:k8s": "chant build src --lexicon k8s -o k8s.yaml",
    "build:helm": "chant build src --lexicon helm -o gitlab-cell/Chart.yaml",
    "build:gitlab": "chant build src --lexicon gitlab -o .gitlab-ci.yml",
    "lint": "chant lint src",
    "configure-kubectl": "gcloud container clusters get-credentials gitlab-cells --region ${GCP_REGION:-us-central1} --project ${GCP_PROJECT_ID}",
    "deploy-infra": "kubectl apply -f config.yaml",
    "load-outputs": "bash scripts/load-outputs.sh",
    "apply:system": "kubectl apply -f k8s.yaml -l app.kubernetes.io/part-of=system",
    "apply:cells": "kubectl apply -f k8s.yaml -l app.kubernetes.io/part-of=cells",
    "deploy-cells": "bash scripts/deploy-cells.sh",
    "bootstrap": "bash scripts/bootstrap.sh",
    "deploy": "npm run build && npm run configure-kubectl && npm run deploy-infra && npm run load-outputs && npm run build:k8s && npm run apply:system && npm run apply:cells && npm run deploy-cells",
    "teardown": "bash scripts/teardown.sh"
  },
  "dependencies": {
    "@intentius/chant": "workspace:*",
    "@intentius/chant-lexicon-gcp": "workspace:*",
    "@intentius/chant-lexicon-k8s": "workspace:*",
    "@intentius/chant-lexicon-helm": "workspace:*",
    "@intentius/chant-lexicon-gitlab": "workspace:*"
  }
}
```

#### `src/chant.config.json`

Copy from `aws-gitlab-cells/src/chant.config.json`:

```json
{
  "extends": ["@intentius/chant/lint/presets/strict"],
  "rules": {
    "COR001": "off",
    "COR004": "off",
    "COR009": "off",
    "COR013": "off",
    "EVL001": "off",
    "WAW001": "off",
    "WAW009": "off"
  }
}
```

#### `.env.example`

```
GCP_PROJECT_ID=my-project
GCP_REGION=us-central1
CLUSTER_NAME=gitlab-cells
DOMAIN=gitlab.example.com
MACHINE_TYPE=e2-standard-8
MIN_NODE_COUNT=3
MAX_NODE_COUNT=20
SMTP_ADDRESS=smtp.sendgrid.net
SMTP_PORT=587
SMTP_USER=apikey
SMTP_DOMAIN=gitlab.example.com
LETSENCRYPT_EMAIL=admin@example.com
RUNNER_REPLICAS=2
RUNNER_CONCURRENCY=10
RUNNER_NODE_POOL_ENABLED=false
RUNNER_NODE_POOL_MACHINE_TYPE=e2-standard-4
RUNNER_NODE_POOL_MAX_COUNT=10
INGRESS_REPLICAS=2
PROMETHEUS_REMOTE_WRITE_URL=
```

---

### Phase 2: Config (1 file)

#### `src/config.ts`

Pattern: `aws-gitlab-cells/src/config.ts` — interface + array + shared object.

```ts
export interface SidekiqQueueConfig {
  name: string;               // e.g., "urgent", "default", "long-running"
  queues: string[];           // e.g., ["post_receive", "pipeline_processing"]
  replicas: number;
  cpuRequest: string;
  memoryRequest: string;
}

export interface CellConfig {
  name: string;
  // Cell identity (required for GitLab Cells)
  cellId: number;                  // unique integer per cell (1, 2, 3...)
  sequenceOffset: number;          // unique offset to avoid PK collisions (e.g., 0, 1000000)
  // Cloud SQL
  pgTier: string;
  pgDiskSize: number;
  pgHighAvailability: boolean;
  pgReadReplicas: number;        // 0 = none, 1+ = read replicas for load balancing
  pgBouncerEnabled: boolean;     // PgBouncer for connection pooling
  // Webservice
  webserviceReplicas: number;    // Puma pods per cell (2+ for production)
  // Memorystore (2 per cell)
  redisPersistentTier: string;    // queues, shared_state — STANDARD_HA recommended
  redisPersistentSizeGb: number;
  redisCacheTier: string;         // cache, sessions — BASIC ok (reconstructable)
  redisCacheSizeGb: number;
  // GCS
  bucketLocation: string;
  artifactRetentionDays: number; // lifecycle policy, e.g., 90. 0 = no expiry
  // K8s
  host: string;
  cpuQuota: string;               // e.g., "16"
  memoryQuota: string;            // e.g., "32Gi"
  // Deployment
  canary: boolean;
  // Gitaly
  gitalyDiskSizeGb: number;
  // Sidekiq
  sidekiqQueues: SidekiqQueueConfig[];
}

export const cells: CellConfig[] = [
  {
    name: "alpha",
    cellId: 1,
    sequenceOffset: 0,
    pgTier: "db-custom-4-15360",
    pgDiskSize: 50,
    pgHighAvailability: true,
    pgReadReplicas: 1,
    pgBouncerEnabled: true,
    webserviceReplicas: 3,
    redisPersistentTier: "STANDARD_HA",
    redisPersistentSizeGb: 5,
    redisCacheTier: "STANDARD_HA",
    redisCacheSizeGb: 2,
    bucketLocation: "US",
    artifactRetentionDays: 90,
    host: "alpha.gitlab.example.com",
    cpuQuota: "16",
    memoryQuota: "32Gi",
    canary: true,
    gitalyDiskSizeGb: 100,
    sidekiqQueues: [
      { name: "urgent", queues: ["post_receive", "pipeline_processing"], replicas: 2, cpuRequest: "500m", memoryRequest: "1Gi" },
      { name: "default", queues: ["default", "mailers"], replicas: 2, cpuRequest: "250m", memoryRequest: "512Mi" },
      { name: "long-running", queues: ["repository_import", "pipeline_schedule"], replicas: 1, cpuRequest: "250m", memoryRequest: "1Gi" },
    ],
  },
  {
    name: "beta",
    cellId: 2,
    sequenceOffset: 1000000,
    pgTier: "db-custom-2-7680",
    pgDiskSize: 20,
    pgHighAvailability: true,
    pgReadReplicas: 0,
    pgBouncerEnabled: true,
    webserviceReplicas: 2,
    redisPersistentTier: "STANDARD_HA",
    redisPersistentSizeGb: 3,
    redisCacheTier: "BASIC",
    redisCacheSizeGb: 1,
    bucketLocation: "US",
    artifactRetentionDays: 30,
    host: "beta.gitlab.example.com",
    cpuQuota: "8",
    memoryQuota: "16Gi",
    canary: false,
    gitalyDiskSizeGb: 50,
    sidekiqQueues: [
      { name: "all-queues", queues: ["*"], replicas: 2, cpuRequest: "500m", memoryRequest: "1Gi" },
    ],
  },
];

export const shared = {
  projectId: process.env.GCP_PROJECT_ID ?? "my-project",
  region: process.env.GCP_REGION ?? "us-central1",
  clusterName: "gitlab-cells",
  domain: process.env.DOMAIN ?? "gitlab.example.com",
  gitlabChartVersion: "8.7.2",
  // Cluster
  machineType: process.env.MACHINE_TYPE ?? "e2-standard-8",
  minNodeCount: Number(process.env.MIN_NODE_COUNT ?? "3"),
  maxNodeCount: Number(process.env.MAX_NODE_COUNT ?? "20"),
  nodeDiskSizeGb: Number(process.env.NODE_DISK_SIZE_GB ?? "200"),
  releaseChannel: "REGULAR",
  // Networking
  nodeSubnetCidr: "10.0.0.0/20",
  podSubnetCidr: "10.4.0.0/14",
  serviceSubnetCidr: "10.8.0.0/20",
  // Ingress
  ingressReplicas: Number(process.env.INGRESS_REPLICAS ?? "2"),
  ingressHpaEnabled: true,
  ingressHpaMaxReplicas: 10,
  // SMTP
  smtpAddress: process.env.SMTP_ADDRESS ?? "smtp.sendgrid.net",
  smtpPort: Number(process.env.SMTP_PORT ?? "587"),
  smtpUser: process.env.SMTP_USER ?? "apikey",
  smtpDomain: process.env.SMTP_DOMAIN ?? "gitlab.example.com",
  // TLS
  letsEncryptEmail: process.env.LETSENCRYPT_EMAIL ?? "admin@example.com",
  // Runner
  runnerImage: "gitlab/gitlab-runner:v17.8",
  runnerReplicas: Number(process.env.RUNNER_REPLICAS ?? "2"),
  runnerConcurrency: Number(process.env.RUNNER_CONCURRENCY ?? "10"),
  runnerNodePoolEnabled: process.env.RUNNER_NODE_POOL_ENABLED === "true",
  runnerNodePoolMachineType: process.env.RUNNER_NODE_POOL_MACHINE_TYPE ?? "e2-standard-4",
  runnerNodePoolMaxCount: Number(process.env.RUNNER_NODE_POOL_MAX_COUNT ?? "10"),
  // Topology Service
  topologyDbTier: "db-custom-1-3840",
  topologyServiceImage: `gcr.io/${process.env.GCP_PROJECT_ID ?? "my-project"}/topology-service:latest`, // Built from gitlab-org/cells/topology-service
  // Monitoring
  prometheusRemoteWriteUrl: process.env.PROMETHEUS_REMOTE_WRITE_URL ?? "",
};
```

---

### Phase 3: GCP Infrastructure (10 files)

All import from `@intentius/chant-lexicon-gcp`. Pattern: `k8s-gke-microservice/src/infra/`.

#### `src/gcp/networking.ts`

Composite: `VpcNetwork` — returns `{ network, subnet_nodes, subnet_pods, firewallAllowInternal, firewallAllowIapSsh, router, routerNat }`.

```ts
import { VpcNetwork, PrivateService } from "@intentius/chant-lexicon-gcp";
import { shared } from "../config";

export const network = VpcNetwork({
  name: shared.clusterName,
  subnets: [
    {
      name: "nodes",
      ipCidrRange: shared.nodeSubnetCidr,
      region: shared.region,
      // GKE secondary ranges for VPC-native cluster (pods + services)
      secondaryIpRanges: [
        { rangeName: "pods", ipCidrRange: shared.podSubnetCidr },
        { rangeName: "services", ipCidrRange: shared.serviceSubnetCidr },
      ],
    },
  ],
  enableNat: true,
  natRegion: shared.region,
  allowInternalTraffic: true,
  allowIapSsh: true,
});

// VPC peering for Cloud SQL + Memorystore private IP access
export const privateServices = PrivateService({
  name: "gitlab-cells-private",
  networkRef: { name: shared.clusterName },
  addressPrefix: "10.100.0.0",
  prefixLength: 16,
});
```

#### `src/gcp/cluster.ts`

Composite: `GkeCluster` — returns `{ cluster, nodePool }`.

```ts
import { GkeCluster } from "@intentius/chant-lexicon-gcp";
import { shared } from "../config";

export const { cluster, nodePool } = GkeCluster({
  name: shared.clusterName,
  location: shared.region,
  machineType: shared.machineType,
  minNodeCount: shared.minNodeCount,
  maxNodeCount: shared.maxNodeCount,
  diskSizeGb: shared.nodeDiskSizeGb,
  releaseChannel: shared.releaseChannel,
  workloadIdentity: true,
});

// Optional dedicated runner node pool with taints
import { NodePool } from "@intentius/chant-lexicon-gcp";

export const runnerNodePool = shared.runnerNodePoolEnabled
  ? new NodePool({
      metadata: { name: `${shared.clusterName}-runners` },
      spec: {
        location: shared.region,
        clusterRef: { name: shared.clusterName },
        autoscaling: {
          minNodeCount: 0,
          maxNodeCount: shared.runnerNodePoolMaxCount,
        },
        nodeConfig: {
          machineType: shared.runnerNodePoolMachineType,
          diskSizeGb: 100,
          oauthScopes: ["https://www.googleapis.com/auth/cloud-platform"],
          workloadMetadataConfig: { mode: "GKE_METADATA" },
          taint: [{
            key: "gitlab.com/runner-only",
            value: "true",
            effect: "NO_SCHEDULE",
          }],
          labels: { "gitlab.com/node-role": "runner" },
        },
      },
    })
  : null;
```

#### `src/gcp/databases.ts`

Composite: `CloudSqlInstance` — returns `{ instance, database, user }`.

Props available: `name`, `databaseVersion` (default "POSTGRES_15"), `tier` (default "db-f1-micro"), `region`, `databaseName`, `userName` (default "admin"), `diskSize` (default 10), `diskAutoresize` (default true), `backupEnabled` (default true), `highAvailability` (default false), `labels`, `namespace`, `defaults`.

```ts
import { CloudSqlInstance } from "@intentius/chant-lexicon-gcp";
import { cells, shared } from "../config";

// Per-cell databases via cells.map()
export const cellDatabases = cells.map(c => CloudSqlInstance({
  name: `gitlab-${c.name}-db`,
  databaseVersion: "POSTGRES_16",
  tier: c.pgTier,
  region: shared.region,
  databaseName: "gitlabhq_production",
  diskSize: c.pgDiskSize,
  highAvailability: c.pgHighAvailability,
  backupEnabled: true,
}));

// Read replicas (conditional on pgReadReplicas > 0)
import { SQLInstance } from "@intentius/chant-lexicon-gcp";

export const readReplicas = cells.flatMap(c =>
  Array.from({ length: c.pgReadReplicas }, (_, i) =>
    new SQLInstance({
      metadata: { name: `gitlab-${c.name}-db-replica-${i}` },
      spec: {
        databaseVersion: "POSTGRES_16",
        region: shared.region,
        masterInstanceRef: { name: `gitlab-${c.name}-db` },
        settings: {
          tier: c.pgTier,
          diskSize: c.pgDiskSize,
          ipConfiguration: {
            ipv4Enabled: false,
            privateNetworkRef: { name: shared.clusterName },
          },
        },
      },
    })
  )
);

// Topology service database
export const topologyDb = CloudSqlInstance({
  name: "gitlab-topology-db",
  databaseVersion: "POSTGRES_16",
  tier: shared.topologyDbTier,
  region: shared.region,
  databaseName: "topology_production",
});
```

#### `src/gcp/cache.ts`

Composite: `MemorystoreInstance` (NEW — to be created) — returns `{ instance }`.

Props: `name`, `region`, `memorySizeGb`, `tier` (default "BASIC"), `redisVersion` (default "REDIS_7_0"), `authEnabled` (default true), `transitEncryptionMode` (default "SERVER_AUTHENTICATION"), `connectMode` (default "PRIVATE_SERVICE_ACCESS"), `authorizedNetworkRef`, `customerManagedKeyRef`, `maintenanceWindow`, `persistenceEnabled`, `labels`, `namespace`, `defaults`.

```ts
import { MemorystoreInstance } from "@intentius/chant-lexicon-gcp";
import { cells, shared } from "../config";

// Each cell gets 2 Redis: persistent (queues, shared_state) + cache (cache, sessions)

export const persistentRedis = cells.map(c => MemorystoreInstance({
  name: `gitlab-${c.name}-persistent`,
  region: shared.region,
  memorySizeGb: c.redisPersistentSizeGb,
  tier: c.redisPersistentTier,
  authorizedNetworkRef: { name: shared.clusterName },
  persistenceEnabled: true,
}));

export const cacheRedis = cells.map(c => MemorystoreInstance({
  name: `gitlab-${c.name}-cache`,
  region: shared.region,
  memorySizeGb: c.redisCacheSizeGb,
  tier: c.redisCacheTier,
  authorizedNetworkRef: { name: shared.clusterName },
}));
```

#### `src/gcp/storage.ts`

Composite: `GcsBucket` — returns `{ bucket }`.

Props available: `name`, `location` (default "US"), `storageClass`, `uniformBucketLevelAccess` (default true), `versioning`, `kmsKeyName`, `lifecycleDeleteAfterDays`, `lifecycleNearlineAfterDays`, `labels`, `namespace`, `defaults`.

Per cell: artifacts bucket (uploads, LFS, artifacts, packages) + registry bucket. Versioning enabled for data protection.

```ts
import { GcsBucket } from "@intentius/chant-lexicon-gcp";
import { cells, shared } from "../config";

export const artifactsBuckets = cells.map(c => GcsBucket({
  name: `${shared.projectId}-${c.name}-artifacts`,
  location: c.bucketLocation,
  versioning: true,
  ...(c.artifactRetentionDays > 0 && {
    lifecycleDeleteAfterDays: c.artifactRetentionDays,
    lifecycleNearlineAfterDays: 30,
  }),
}));

export const registryBuckets = cells.map(c => GcsBucket({
  name: `${shared.projectId}-${c.name}-registry`,
  location: c.bucketLocation,
}));
```

#### `src/gcp/dns.ts`

Composite: `DNSZone` (NEW — to be created) — returns `{ zone, record_<name>... }`.

Props: `name`, `dnsName`, `description`, `visibility` (default "public"), `dnssecEnabled` (default false), `records` (array of `{ name, type, ttl?, rrdatas }`), `labels`, `namespace`, `defaults`.

```ts
import { DNSZone } from "@intentius/chant-lexicon-gcp";
import { shared } from "../config";

export const dns = DNSZone({
  name: "gitlab-cells",
  dnsName: `${shared.domain}.`,
  records: [
    { name: `*.${shared.domain}.`, type: "A", rrdatas: ["INGRESS_IP"], ttl: 300 },
  ],
});
```

#### `src/gcp/encryption.ts`

Composite: `KMSEncryption` (NEW — to be created) — returns `{ keyRing, cryptoKey }`.

Props: `name`, `location`, `purpose` (default "ENCRYPT_DECRYPT"), `rotationPeriod` (default "7776000s" / 90 days), `algorithm` (default "GOOGLE_SYMMETRIC_ENCRYPTION"), `destroyScheduledDuration` (default "86400s"), `labels`, `namespace`, `defaults`.

```ts
import { KMSEncryption } from "@intentius/chant-lexicon-gcp";
import { shared } from "../config";

export const { keyRing, cryptoKey } = KMSEncryption({
  name: "gitlab-cells",
  location: shared.region,
  rotationPeriod: "7776000s",
});
```

#### `src/gcp/iam.ts`

Resources: `GCPServiceAccount` + `IAMPolicyMember`.

Pattern: `k8s-gke-microservice/src/infra/cluster.ts` (exact same resources).

`cells.map()` — per cell:
1. `GCPServiceAccount` — workload identity SA
2. `IAMPolicyMember` — WI binding (`roles/iam.workloadIdentityUser`)
3. `IAMPolicyMember` — GCS access: bucket-scoped `objectAdmin` on `${projectId}-${cell.name}-artifacts` and `${projectId}-${cell.name}-registry` (not project-level — limits blast radius)

Also:
- SA for External Secrets Operator with `roles/secretmanager.secretAccessor`
- SA for cert-manager with `roles/dns.admin` (required for DNS-01 ACME solver)

#### `src/gcp/secrets.ts`

Resources: `SecretManagerSecret` + `SecretManagerSecretVersion` from `@intentius/chant-lexicon-gcp`.

Per cell, create secrets for:
1. `gitlab-<cell>-db-password` — Cloud SQL password
2. `gitlab-<cell>-redis-password` — Redis AUTH token (persistent instance)
3. `gitlab-<cell>-redis-cache-password` — Redis AUTH token (cache instance)
4. `gitlab-<cell>-root-password` — Initial GitLab root/admin password
5. `gitlab-<cell>-rails-secret` — Rails `secret_key_base`
6. `gitlab-smtp-password` — SMTP password (shared across cells)

```ts
import { SecretManagerSecret, SecretManagerSecretVersion } from "@intentius/chant-lexicon-gcp";
import { cells, shared } from "../config";

function cellSecrets(cellName: string) {
  const secrets = ["db-password", "redis-password", "redis-cache-password", "root-password", "rails-secret"];
  return secrets.map(key => {
    const secret = new SecretManagerSecret({
      metadata: { name: `gitlab-${cellName}-${key}` },
      spec: {
        replication: { automatic: {} },
      },
    });
    // SecretManagerSecretVersion — placeholder, real values set via gcloud CLI or CI
    const version = new SecretManagerSecretVersion({
      metadata: { name: `gitlab-${cellName}-${key}-v1` },
      spec: {
        secretRef: { name: `gitlab-${cellName}-${key}` },
        secretData: { value: "PLACEHOLDER" },  // Replaced in deploy script
      },
    });
    return { secret, version };
  });
}

export const cellSecretSets = cells.map(c => cellSecrets(c.name));

// Shared SMTP secret
export const smtpSecret = new SecretManagerSecret({
  metadata: { name: "gitlab-smtp-password" },
  spec: { replication: { automatic: {} } },
});
```

#### `src/gcp/outputs.ts`

Export Config Connector resource references for cross-lexicon use by `load-outputs.sh`.

```ts
import { cellDatabases, topologyDb, readReplicas } from "./databases";
import { persistentRedis, cacheRedis } from "./cache";
import { artifactsBuckets, registryBuckets } from "./storage";
import { cells } from "../config";

// Export references so load-outputs.sh can query these resources
// kubectl get sqlinstances gitlab-alpha-db -o jsonpath='{.status.ipAddresses[0].ipAddress}'
export const outputs = {
  cellDatabases: cells.map((c, i) => ({
    cell: c.name,
    sqlInstance: `gitlab-${c.name}-db`,
    readReplica: c.pgReadReplicas > 0 ? `gitlab-${c.name}-db-replica-0` : null,
  })),
  topologyDb: "gitlab-topology-db",
  redis: cells.map(c => ({
    cell: c.name,
    persistent: `gitlab-${c.name}-persistent`,
    cache: `gitlab-${c.name}-cache`,
  })),
  buckets: cells.map(c => ({
    cell: c.name,
    artifacts: `${c.name}-artifacts`,
    registry: `${c.name}-registry`,
  })),
};
```

---

### Phase 4: K8s Resources (9 files)

All import from `@intentius/chant-lexicon-k8s`.

#### `src/system/namespace.ts`

Composite: `NamespaceEnv` — returns `{ namespace, resourceQuota?, limitRange?, networkPolicy? }`.

Props available: `name`, `cpuQuota`, `memoryQuota`, `maxPods`, `defaultCpuRequest`, `defaultMemoryRequest`, `defaultCpuLimit`, `defaultMemoryLimit`, `defaultDenyIngress`, `defaultDenyEgress`, `labels`, `defaults`.

```ts
import { NamespaceEnv } from "@intentius/chant-lexicon-k8s";
export const { namespace, resourceQuota, limitRange } = NamespaceEnv({
  name: "system",
  cpuQuota: "32",
  memoryQuota: "64Gi",
  defaultCpuRequest: "100m",
  defaultMemoryRequest: "128Mi",
  defaultCpuLimit: "1",
  defaultMemoryLimit: "1Gi",
  labels: { "app.kubernetes.io/part-of": "system" },
});
```

#### `src/system/ingress-controller.ts`

Raw resources: `Deployment`, `Service`, `ConfigMap`, `PodDisruptionBudget`, `HorizontalPodAutoscaler` from `@intentius/chant-lexicon-k8s`.

NGINX ingress controller in system namespace. Routes by host header to cell namespaces. TLS termination using certs provisioned by cert-manager. ConfigMap sets `use-forwarded-headers: "true"`, `ssl-redirect: "true"`.

HPA (conditional on `shared.ingressHpaEnabled`):

```ts
import { HorizontalPodAutoscaler } from "@intentius/chant-lexicon-k8s";
import { shared } from "../config";

export const ingressHpa = shared.ingressHpaEnabled
  ? new HorizontalPodAutoscaler({
      metadata: { name: "ingress-nginx-controller", namespace: "system" },
      spec: {
        scaleTargetRef: {
          apiVersion: "apps/v1",
          kind: "Deployment",
          name: "ingress-nginx-controller",
        },
        minReplicas: shared.ingressReplicas,
        maxReplicas: shared.ingressHpaMaxReplicas,
        metrics: [
          { type: "Resource", resource: { name: "cpu", target: { type: "Utilization", averageUtilization: 70 } } },
        ],
      },
    })
  : null;
```

#### `src/system/cert-manager.ts`

Raw resources: `Deployment`, `Service`, `ServiceAccount`, `ClusterRole`, `ClusterRoleBinding`, `CustomResourceDefinition` (or rely on pre-installed CRDs).

In practice, cert-manager is complex to deploy from raw resources. Recommend deploying via `kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.14.4/cert-manager.yaml` in the deploy script, then create the `ClusterIssuer` via Chant:

```ts
import { createResource } from "@intentius/chant/runtime";
import { shared } from "../config";

// Create dedicated CR constructor (K8s lexicon has no CustomResource class — use createResource)
const ClusterIssuer = createResource("K8s::CertManager::ClusterIssuer", "k8s", {});

// ClusterIssuer for Let's Encrypt — DNS-01 solver (HTTP-01 can't issue wildcards)
export const letsEncryptIssuer = new ClusterIssuer({
  metadata: { name: "letsencrypt-prod", namespace: "system" },
  spec: {
    acme: {
      server: "https://acme-v02.api.letsencrypt.org/directory",
      email: shared.letsEncryptEmail,
      privateKeySecretRef: { name: "letsencrypt-prod-key" },
      solvers: [{
        dns01: {
          cloudDNS: {
            project: shared.projectId,
          },
        },
      }],
    },
  },
});
```

Note: cert-manager SA needs `roles/dns.admin` IAM binding (configured in `iam.ts`).

#### `src/system/external-secrets.ts`

External Secrets Operator deployed via deploy script (`helm install external-secrets external-secrets/external-secrets -n system`). Chant generates the `ClusterSecretStore` pointing to GCP Secret Manager:

```ts
import { createResource } from "@intentius/chant/runtime";
import { shared } from "../config";

const ClusterSecretStore = createResource("K8s::ExternalSecrets::ClusterSecretStore", "k8s", {});

export const gcpSecretStore = new ClusterSecretStore({
  metadata: { name: "gcp-secret-manager" },
  spec: {
    provider: {
      gcpsm: {
        projectID: shared.projectId,
        auth: {
          workloadIdentity: {
            clusterLocation: shared.region,
            clusterName: shared.clusterName,
            serviceAccountRef: { name: "external-secrets-sa", namespace: "system" },
          },
        },
      },
    },
  },
});
```

#### `src/system/topology-service.ts`

Raw resources: `Deployment`, `Service`, `ConfigMap`.

Topology Service Go binary. ConfigMap contains DB connection string pointing to topology Cloud SQL.

#### `src/system/monitoring.ts`

Raw resources: `Deployment`, `Service`, `ConfigMap`.

Prometheus with cell-aware scrape config. ConfigMap contains scrape targets for each cell namespace. Optional `remote_write` for scaling beyond single instance:

```ts
import { ConfigMap } from "@intentius/chant-lexicon-k8s";
import { cells, shared } from "../config";

const remoteWriteConfig = shared.prometheusRemoteWriteUrl
  ? `remote_write:\n  - url: "${shared.prometheusRemoteWriteUrl}"\n`
  : "";

export const prometheusConfig = new ConfigMap({
  metadata: { name: "prometheus-config", namespace: "system" },
  data: {
    "prometheus.yml": `
global:
  scrape_interval: 15s
${remoteWriteConfig}
scrape_configs:
  - job_name: "gitlab-cells"
    kubernetes_sd_configs:
      - role: pod
        namespaces:
          names: [${cells.map(c => `"cell-${c.name}"`).join(", ")}]
    relabel_configs:
      - source_labels: [__meta_kubernetes_namespace]
        regex: "cell-(.*)"
        target_label: cell
`,
  },
});
```

#### `src/system/gitlab-runner.ts`

Raw resources: `Deployment`, `ConfigMap`, `ServiceAccount` from `@intentius/chant-lexicon-k8s`.

Shared GitLab Runner fleet in system namespace using Kubernetes executor. Registers against the canary cell's GitLab instance.

```ts
import { Deployment, ConfigMap, ServiceAccount } from "@intentius/chant-lexicon-k8s";
import { cells, shared } from "../config";

const canaryCell = cells.find(c => c.canary)!;

export const runnerSa = new ServiceAccount({
  metadata: { name: "gitlab-runner", namespace: "system" },
});

export const runnerConfig = new ConfigMap({
  metadata: { name: "gitlab-runner-config", namespace: "system" },
  data: {
    "config.toml": `
concurrent = ${shared.runnerConcurrency}
[[runners]]
  name = "cells-runner"
  url = "https://${canaryCell.host}"
  executor = "kubernetes"
  [runners.kubernetes]
    namespace = "system"
    service_account = "gitlab-runner"
    image = "alpine:latest"
`,
  },
});

export const runnerDeployment = new Deployment({
  metadata: {
    name: "gitlab-runner",
    namespace: "system",
    labels: { "app.kubernetes.io/name": "gitlab-runner", "app.kubernetes.io/part-of": "system" },
  },
  spec: {
    replicas: shared.runnerReplicas,
    selector: { matchLabels: { "app.kubernetes.io/name": "gitlab-runner" } },
    template: {
      metadata: { labels: { "app.kubernetes.io/name": "gitlab-runner" } },
      spec: {
        serviceAccountName: "gitlab-runner",
        containers: [{
          name: "runner",
          image: shared.runnerImage,
          command: ["gitlab-runner", "run"],
          volumeMounts: [{ name: "config", mountPath: "/etc/gitlab-runner" }],
        }],
        volumes: [{ name: "config", configMap: { name: "gitlab-runner-config" } }],
      },
    },
  },
});
```

Note: GitLab 16+ uses authentication tokens (registration tokens are deprecated). Runners can't register until GitLab is up. The `register-runners` pipeline stage (after cell deployment) creates a runner token via `gitlab-rails runner`, stores it in a K8s secret, and restarts the runner pods. The runner config.toml mounts the token from the secret.

#### `src/cell/factory.ts`

Pattern: `aws-gitlab-cells/src/cell/factory.ts` — factory function returning resource bundle.

```ts
import { NamespaceEnv, NetworkPolicy, WorkloadIdentityServiceAccount } from "@intentius/chant-lexicon-k8s";
import { createResource } from "@intentius/chant/runtime";
import type { CellConfig } from "../config";
import { shared } from "../config";

// Create dedicated CR constructors (K8s lexicon has no CustomResource class)
const ExternalSecret = createResource("K8s::ExternalSecrets::ExternalSecret", "k8s", {});

export function createCell(cell: CellConfig) {
  const ns = `cell-${cell.name}`;

  const { namespace, resourceQuota, limitRange, networkPolicy: defaultDeny } = NamespaceEnv({
    name: ns,
    cpuQuota: cell.cpuQuota, memoryQuota: cell.memoryQuota,
    defaultDenyIngress: true, defaultDenyEgress: true,
    labels: {
      "app.kubernetes.io/part-of": "cells",
      "gitlab.example.com/cell": cell.name,
      "pod-security.kubernetes.io/enforce": "baseline",
    },
  });

  // Allow ingress from system namespace (same pattern as aws-gitlab-cells)
  const allowIngressFromSystem = new NetworkPolicy({ ... });

  // Allow egress to DNS + GCP APIs + Cloud SQL + Memorystore
  const allowEgress = new NetworkPolicy({ ... });

  // ── ExternalSecrets (synced from GCP Secret Manager) ──────────
  // Note: rails-secret must map the full YAML blob (secret_key_base, db_key_base,
  // otp_key_base, encrypted_settings_key_base), not just a single "password" key.

  const externalSecrets = [
    { k8sName: "gitlab-db-password", remoteKey: `gitlab-${cell.name}-db-password`, secretKey: "password" },
    { k8sName: "gitlab-redis-password", remoteKey: `gitlab-${cell.name}-redis-password`, secretKey: "password" },
    { k8sName: "gitlab-redis-cache-password", remoteKey: `gitlab-${cell.name}-redis-cache-password`, secretKey: "password" },
    { k8sName: "gitlab-root-password", remoteKey: `gitlab-${cell.name}-root-password`, secretKey: "password" },
    { k8sName: "gitlab-rails-secret", remoteKey: `gitlab-${cell.name}-rails-secret`, secretKey: "rails-secret.yml" },
    { k8sName: "gitlab-smtp-password", remoteKey: "gitlab-smtp-password", secretKey: "password" },
  ].map(({ k8sName, remoteKey, secretKey }) => new ExternalSecret({
    metadata: { name: k8sName, namespace: ns },
    spec: {
      refreshInterval: "1h",
      secretStoreRef: { name: "gcp-secret-manager", kind: "ClusterSecretStore" },
      target: { name: k8sName },
      data: [{ secretKey, remoteRef: { key: remoteKey } }],
    },
  }));

  // ── Registry storage config secret ────────────────────────────

  const registryStorageSecret = new ExternalSecret({
    metadata: { name: "registry-storage", namespace: ns },
    spec: {
      refreshInterval: "1h",
      secretStoreRef: { name: "gcp-secret-manager", kind: "ClusterSecretStore" },
      target: {
        name: "registry-storage",
        template: {
          data: {
            config: `{ "gcs": { "bucket": "${shared.projectId}-${cell.name}-registry" } }`,
          },
        },
      },
      data: [],  // No remote data needed — template-only
    },
  });

  // Workload Identity SA binding
  const { serviceAccount } = WorkloadIdentityServiceAccount({
    name: `${cell.name}-sa`,
    gcpServiceAccountEmail: `gitlab-${cell.name}@${shared.projectId}.iam.gserviceaccount.com`,
    namespace: ns,
  });

  return {
    namespace, resourceQuota, limitRange, defaultDeny,
    allowIngressFromSystem, allowEgress,
    externalSecrets, registryStorageSecret,
    serviceAccount,
  };
}
```

Key differences from AWS example:
- `WorkloadIdentityServiceAccount` instead of `IrsaServiceAccount`
- No `AutoscaledService` — GitLab Helm chart handles the workload
- `ExternalSecret` CRDs instead of plain `Secret` — secrets synced from GCP Secret Manager
- Registry storage config generated via ExternalSecret template

#### `src/cell/index.ts`

Config-driven fan-out — no per-cell files needed. Adding a cell means adding one entry to `cells[]`.

```ts
import { createCell } from "./factory";
import { cells } from "../config";

export const cellResources = cells.map(c => createCell(c));
```

---

### Phase 5: Helm Chart (1 file)

#### `src/helm/gitlab-cell.ts`

Resources: `Chart`, `Values`, `HelmDependency` from `@intentius/chant-lexicon-helm`.
Intrinsics: `values()` for Helm template references.

```ts
import { Chart, Values, HelmDependency } from "@intentius/chant-lexicon-helm";
import { values as v } from "@intentius/chant-lexicon-helm";
import { shared } from "../config";

export const chart = new Chart({
  apiVersion: "v2",
  name: "gitlab-cell",
  version: "0.1.0",
  appVersion: shared.gitlabChartVersion,
  type: "application",
  description: "GitLab cell wrapper chart — deploys gitlab/gitlab with cell-specific config",
});

export const gitlabDep = new HelmDependency({
  name: "gitlab",
  version: shared.gitlabChartVersion,
  repository: "https://charts.gitlab.io",
});

export const cellValues = new Values({
  // ── Cell-specific inputs (overridden in values-<cell>.yaml) ──
  cellDomain: "",
  cellName: "",
  cellId: 0,
  sequenceOffset: 0,
  pgHost: "",
  pgReadReplicaHost: "",      // "" = no read replica
  pgBouncerEnabled: true,
  redisPersistentHost: "",
  redisCacheHost: "",
  projectId: "",
  artifactsBucket: "",
  registryBucket: "",
  smtpAddress: "",
  smtpPort: 587,
  smtpUser: "",
  smtpDomain: "",
  gitalyDiskSize: "50Gi",
  webserviceReplicas: 2,
  sidekiqPods: {},             // Generated from SidekiqQueueConfig[] at build time

  // ── Global config ───────────────────────────────────────────
  global: {
    hosts: {
      domain: v("cellDomain"),
      https: true,
    },

    // Cells identity (REQUIRED for multi-cell GitLab)
    cells: {
      enabled: true,
      id: v("cellId"),
      topology_service: {
        address: "topology-service.system.svc:8080",
      },
      sequence_offset: v("sequenceOffset"),
    },

    // TLS
    ingress: {
      configureCertmanager: false,
      tls: { enabled: true, secretName: "gitlab-tls" },
      annotations: { "cert-manager.io/cluster-issuer": "letsencrypt-prod" },
    },

    // External PostgreSQL + PgBouncer + read replica load balancing
    psql: {
      host: v("pgHost"),
      port: 5432,
      database: "gitlabhq_production",
      password: { secret: "gitlab-db-password", key: "password" },
      // PgBouncer — always include, chart handles enabled=false gracefully
      // Note: v() returns HelmTpl objects (always truthy), so spread conditionals don't work
      pgbouncer: v("pgBouncerEnabled"),
      // Read replica load balancing — configured per-cell in values-<cell>.yaml
      // Only include load_balancing block in values file when pgReadReplicaHost is non-empty
    },

    // External Redis (split)
    redis: {
      host: v("redisPersistentHost"),
      auth: { enabled: true, secret: "gitlab-redis-password", key: "password" },
      cache: {
        host: v("redisCacheHost"),
        password: { enabled: true, secret: "gitlab-redis-cache-password", key: "password" },
      },
      sharedState: {
        host: v("redisPersistentHost"),
        password: { enabled: true, secret: "gitlab-redis-password", key: "password" },
      },
      queues: {
        host: v("redisPersistentHost"),
        password: { enabled: true, secret: "gitlab-redis-password", key: "password" },
      },
      actioncable: {
        host: v("redisCacheHost"),
        password: { enabled: true, secret: "gitlab-redis-cache-password", key: "password" },
      },
    },

    // Root password + Rails secrets
    initialRootPassword: { secret: "gitlab-root-password", key: "password" },
    railsSecrets: { secret: "gitlab-rails-secret" },

    // Object storage (GCS via Workload Identity)
    minio: { enabled: false },
    appConfig: {
      object_store: {
        enabled: true,
        connection: {
          provider: "Google",
          google_project: v("projectId"),
          google_application_default: true,  // Workload Identity — no key file
        },
      },
      artifacts: { bucket: v("artifactsBucket") },
      uploads: { bucket: v("artifactsBucket") },
      lfs: { bucket: v("artifactsBucket") },
      packages: { bucket: v("artifactsBucket") },
    },

    // SMTP
    smtp: {
      enabled: true,
      address: v("smtpAddress"),
      port: v("smtpPort"),
      user_name: v("smtpUser"),
      domain: v("smtpDomain"),
      authentication: "plain",
      starttls_auto: true,
      password: { secret: "gitlab-smtp-password", key: "password" },
    },

    // Container registry
    registry: {
      enabled: true,
      storage: { secret: "registry-storage", key: "config" },
    },
  },

  // ── GitLab component config ─────────────────────────────
  gitlab: {
    webservice: {
      replicas: v("webserviceReplicas"),
    },
    // Sidekiq queue isolation — map format (one key per queue group)
    // Generated at build time from cell.sidekiqQueues → { [name]: { queues, replicas, resources } }
    sidekiq: {
      pods: v("sidekiqPods"),    // Object, not array. Generated from SidekiqQueueConfig[]
    },
    // PgBouncer pool config (applies when global.psql.pgbouncer is true)
    pgbouncer: {
      default_pool_size: 20,
      min_pool_size: 5,
      max_client_conn: 150,
    },
    gitaly: {
      persistence: {
        enabled: true,
        size: v("gitalyDiskSize"),
        storageClass: "standard-rwo",
      },
    },
  },

  // ── Disable bundled services ──────────────────────────────
  postgresql: { install: false },
  redis: { install: false },
});
```

Serializer merges `HelmDependency` into `Chart.yaml` automatically. Build output: `chant build src --lexicon helm -o gitlab-cell/Chart.yaml` generates the chart directory.

Per-cell values files (`values-alpha.yaml`, `values-beta.yaml`) are generated by the deploy script from config.ts, providing the cell-specific values (pgHost, redisPersistentHost, redisCacheHost, domain, buckets, etc.).

---

### Phase 6: Pipeline (1 file)

#### `src/pipeline/index.ts`

Resources: `Job`, `Image`, `Rule`, `Parallel` from `@intentius/chant-lexicon-gitlab`.

Pattern: `aws-gitlab-cells/src/pipeline/index.ts` — but 9 stages instead of 4.

```ts
import { Job, Image, Rule, Parallel } from "@intentius/chant-lexicon-gitlab";
import { cells } from "../config";

const gcloudImage = new Image({ name: "google/cloud-sdk:slim", entrypoint: [""] });
const kubectlImage = new Image({ name: "bitnami/kubectl:1.31", entrypoint: [""] });
const helmImage = new Image({ name: "alpine/helm:3.14", entrypoint: [""] });

const onlyMain = [new Rule({ if: "$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH" })];
const canaryCells = cells.filter(c => c.canary);
const remainingCells = cells.filter(c => !c.canary);

// Stage 1: infra (Config Connector resources)
export const deployInfra = new Job({ stage: "infra", image: kubectlImage, script: [
  "kubectl apply -f config.yaml",
  "echo 'Waiting for Config Connector resources to reconcile...'",
  "kubectl wait --for=condition=Ready sqlinstances --all --timeout=600s",
], rules: onlyMain });

// Stage 2: system (kubectl apply system namespace + install cert-manager + ESO)
// Uses gcloud-sdk image (has kubectl + can install helm) since this stage needs both
export const deploySystem = new Job({ stage: "system", image: gcloudImage, script: [
  // Install cert-manager (if not already)
  "kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.14.4/cert-manager.yaml || true",
  // Install External Secrets Operator via Helm
  "helm repo add external-secrets https://charts.external-secrets.io",
  "helm upgrade --install external-secrets external-secrets/external-secrets -n system --wait || true",
  // Apply system namespace resources
  "kubectl apply -f k8s.yaml -l app.kubernetes.io/part-of=system",
  "kubectl -n system rollout status deployment/ingress-nginx-controller --timeout=120s",
], needs: [{ job: "deploy-infra" }], rules: onlyMain });

// Stage 3: validate (helm diff dry-run)
export const validate = new Job({ stage: "validate", image: helmImage, allow_failure: true,
  script: cells.map(c =>
    `helm diff upgrade gitlab-cell-${c.name} ./gitlab-cell/ -n cell-${c.name} -f values-${c.name}.yaml || true`
  ),
  needs: [{ job: "deploy-system" }], rules: onlyMain });

// Stage 4: deploy-canary (helm install canary cell)
export const deployCanary = new Job({ stage: "deploy-canary", image: helmImage, script: [
  `helm upgrade --install gitlab-cell-${canaryCells[0].name} ./gitlab-cell/ -n cell-${canaryCells[0].name} -f values-${canaryCells[0].name}.yaml --wait --timeout=900s`,
  `kubectl -n cell-${canaryCells[0].name} rollout status deployment/gitlab-cell-${canaryCells[0].name}-webservice-default --timeout=300s`,
], needs: [{ job: "validate" }], rules: onlyMain });

// Stage 5: deploy-remaining (parallel matrix for non-canary cells)
export const deployRemaining = new Job({ stage: "deploy-remaining", image: helmImage,
  parallel: new Parallel({ matrix: remainingCells.map(c => ({ CELL_NAME: c.name })) }),
  script: [
    "helm upgrade --install gitlab-cell-$CELL_NAME ./gitlab-cell/ -n cell-$CELL_NAME -f values-$CELL_NAME.yaml --wait --timeout=900s",
    "kubectl -n cell-$CELL_NAME rollout status deployment/gitlab-cell-$CELL_NAME-webservice-default --timeout=300s",
  ],
  needs: [{ job: "deploy-canary" }], rules: onlyMain });

// Stage 6: register-runners (after GitLab is up — GitLab 16+ uses authentication tokens)
export const registerRunners = new Job({ stage: "register-runners", image: gcloudImage, script: [
  `RUNNER_TOKEN=$(kubectl -n cell-${canaryCells[0].name} exec deploy/gitlab-cell-${canaryCells[0].name}-toolbox -- gitlab-rails runner "puts Ci::Runner.create!(runner_type: :instance_type, registration_type: :authenticated_user).token")`,
  "kubectl -n system create secret generic gitlab-runner-token --from-literal=token=$RUNNER_TOKEN --dry-run=client -o yaml | kubectl apply -f -",
  "kubectl -n system rollout restart deploy/gitlab-runner",
  "kubectl -n system rollout status deploy/gitlab-runner --timeout=120s",
], needs: [{ job: "deploy-remaining" }], rules: onlyMain });

// Stage 7: smoke-test (E2E validation)
export const smokeTest = new Job({ stage: "smoke-test", image: gcloudImage, script: [
  "bash scripts/e2e-test.sh",
], needs: [{ job: "register-runners" }], rules: onlyMain });

// Stage 8: backup (scheduled — gitaly-backup per cell to GCS)
export const backupGitaly = new Job({ stage: "backup", image: gcloudImage,
  parallel: new Parallel({ matrix: cells.map(c => ({ CELL_NAME: c.name })) }),
  script: [
    "kubectl -n cell-$CELL_NAME exec statefulset/gitlab-cell-$CELL_NAME-gitaly -- gitaly-backup create --server-side --path gs://${GCP_PROJECT_ID}-${CELL_NAME}-artifacts/gitaly-backups/$(date +%Y%m%d)",
  ],
  rules: [new Rule({ if: "$CI_PIPELINE_SOURCE == 'schedule'" })],
});

// Stage 9: migrate-org (manual)
export const migrateOrg = new Job({ stage: "migrate-org", when: "manual", image: kubectlImage,
  script: [
    "echo 'Update Topology Service to reassign org to target cell'",
    "kubectl -n system exec deploy/topology-service -- topology-cli migrate-org --org $ORG_ID --target-cell $TARGET_CELL",
  ],
  rules: onlyMain });
```

---

### Phase 7: Documentation (1 file)

#### `README.md`

Follow `aws-gitlab-cells/README.md` and `cockroachdb-multi-cloud/README.md` structure:
- Title + description (4 lexicons, GitLab Cells on GKE)
- Skills table (13 skills from 4 lexicons — see below)
- "Using Claude Code?" prompt with deploy command
- Skills guide (maps deployment phases to skills)
- Skill workflow diagram (7-phase)
- Agent-guided standup (step-by-step deploy flow)
- Additional useful prompts
- Architecture diagram (from PLAN.md)
- GitLab Cells concept mapping table
- Config-driven fan-out explanation
- Prerequisites (gcloud, kubectl, helm, jq)
- Local verification (`npm run build && npm run lint`)
- Deploy instructions
- Pipeline stages (9-stage)
- Well-Architected alignment (GCP equivalents)
- Outputs table (4 output files)
- Source file tables (per layer)
- Teardown
- Related examples

Skills table content (13 skills from 4 lexicons):

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

"Using Claude Code?" prompt: `Deploy the gcp-gitlab-cells example. My domain is gitlab.mycompany.com.`

Skills guide maps deployment phases to skills (same structure as PLAN.md T7 skills guide — see PLAN.md for full content).

Skill workflow (7-phase): bootstrap → infra → system → helm → pipeline → verify → security audit.

Agent-guided standup steps: bootstrap → build → deploy-infra → load-outputs → apply:system → apply:cells + deploy-cells → e2e-test.

Additional prompts: build+lint, teardown, add a new cell, upgrade chart version.

### Phase 8: E2E Test Script (1 file)

#### `scripts/e2e-test.sh`

Post-deploy validation. Validates the full stack and exits non-zero on any failure.

```bash
#!/usr/bin/env bash
set -euo pipefail

PASS=0; FAIL=0
check() { if "$@"; then ((PASS++)); else ((FAIL++)); echo "FAIL: $*"; fi }

echo "=== Infra Health ==="
check kubectl wait --for=condition=Ready sqlinstances --all --timeout=60s
check kubectl wait --for=condition=Ready redisinstances --all --timeout=60s
# Config-driven bucket check — no hardcoded cell names
for CELL in $(kubectl get ns -l app.kubernetes.io/part-of=cells -o jsonpath='{.items[*].metadata.labels.gitlab\.example\.com/cell}'); do
  check gsutil ls "gs://${GCP_PROJECT_ID}-${CELL}-artifacts" >/dev/null
done

echo "=== System Namespace ==="
check kubectl -n system rollout status deploy/ingress-nginx-controller --timeout=60s
check kubectl -n system rollout status deploy/cert-manager --timeout=60s
check kubectl -n system rollout status deploy/external-secrets --timeout=60s
check kubectl -n system rollout status deploy/gitlab-runner --timeout=60s
check kubectl -n system rollout status deploy/topology-service --timeout=60s
check kubectl -n system rollout status deploy/prometheus --timeout=60s
INGRESS_IP=$(kubectl -n system get svc ingress-nginx-controller -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
check test -n "$INGRESS_IP"

echo "=== Per-Cell GitLab ==="
for CELL in $(kubectl get ns -l app.kubernetes.io/part-of=cells -o jsonpath='{.items[*].metadata.name}'); do
  CELL_NAME=${CELL#cell-}
  HOST="${CELL_NAME}.${DOMAIN}"

  # Pod health (release name = gitlab-cell-<name>, chart prepends to resource names)
  check kubectl -n "$CELL" rollout status deploy/gitlab-cell-${CELL_NAME}-webservice-default --timeout=120s
  check kubectl -n "$CELL" rollout status statefulset/gitlab-cell-${CELL_NAME}-gitaly --timeout=120s
  # PVC bound
  check kubectl -n "$CELL" get pvc -l app=gitaly -o jsonpath='{.items[0].status.phase}' | grep -q Bound

  # HTTP health endpoints
  check curl -sf "https://${HOST}/-/health"
  check curl -sf "https://${HOST}/-/readiness"

  # TLS certificate valid
  check openssl s_client -connect "${HOST}:443" -servername "${HOST}" </dev/null 2>/dev/null | openssl x509 -noout -checkend 0
done

echo "=== Git Operations (canary cell) ==="
CANARY_HOST="alpha.${DOMAIN}"
# Create project via API
TOKEN=$(kubectl -n cell-alpha exec deploy/gitlab-cell-alpha-toolbox -- gitlab-rails runner "puts User.find_by_username('root').personal_access_tokens.create!(name: 'e2e', scopes: [:api]).token")
PROJECT_ID=$(curl -sf -H "PRIVATE-TOKEN: $TOKEN" "https://${CANARY_HOST}/api/v4/projects" -d "name=e2e-test" | jq -r '.id')
check test -n "$PROJECT_ID"
# Clone + push
TMPDIR=$(mktemp -d)
check git clone "https://root:${TOKEN}@${CANARY_HOST}/root/e2e-test.git" "$TMPDIR/e2e-test"
echo "test" > "$TMPDIR/e2e-test/test.txt"
cd "$TMPDIR/e2e-test" && git add . && git commit -m "e2e" && check git push
cd -
# Verify commit via API
check curl -sf -H "PRIVATE-TOKEN: $TOKEN" "https://${CANARY_HOST}/api/v4/projects/${PROJECT_ID}/repository/commits" | jq -e '.[0].message == "e2e"'

echo "=== Container Registry ==="
check docker login "${CANARY_HOST}" -u root -p "$TOKEN"
check docker tag alpine:latest "${CANARY_HOST}/root/e2e-test/alpine:e2e"
check docker push "${CANARY_HOST}/root/e2e-test/alpine:e2e"
check docker pull "${CANARY_HOST}/root/e2e-test/alpine:e2e"

echo "=== Cell Isolation ==="
# From alpha pod, try to reach beta — must fail
check kubectl -n cell-alpha exec deploy/gitlab-cell-alpha-webservice-default -- timeout 5 curl -sf "http://gitlab-cell-beta-webservice-default.cell-beta.svc:8080" && FAIL=$((FAIL+1)) || true
# Verify separate databases
ALPHA_DB=$(kubectl -n cell-alpha exec deploy/gitlab-cell-alpha-toolbox -- gitlab-rails runner "puts ActiveRecord::Base.connection.current_database")
BETA_DB=$(kubectl -n cell-beta exec deploy/gitlab-cell-beta-toolbox -- gitlab-rails runner "puts ActiveRecord::Base.connection.current_database")
check test "$ALPHA_DB" = "gitlabhq_production"
check test "$BETA_DB" = "gitlabhq_production"
# Verify different DB hosts (Cloud SQL IPs)
ALPHA_HOST=$(kubectl -n cell-alpha get secret gitlab-db-password -o jsonpath='{.data.host}' | base64 -d)
BETA_HOST=$(kubectl -n cell-beta get secret gitlab-db-password -o jsonpath='{.data.host}' | base64 -d)
check test "$ALPHA_HOST" != "$BETA_HOST"

echo "=== Topology Routing ==="
check curl -sf "http://topology-service.system.svc:8080/healthz"

echo "=== Runner ==="
# Trigger pipeline and verify runner picks it up
PIPELINE_ID=$(curl -sf -H "PRIVATE-TOKEN: $TOKEN" "https://${CANARY_HOST}/api/v4/projects/${PROJECT_ID}/pipeline" -d "ref=main" | jq -r '.id')
check test -n "$PIPELINE_ID"
sleep 30
JOB_STATUS=$(curl -sf -H "PRIVATE-TOKEN: $TOKEN" "https://${CANARY_HOST}/api/v4/projects/${PROJECT_ID}/pipelines/${PIPELINE_ID}/jobs" | jq -r '.[0].status')
check test "$JOB_STATUS" != "stuck"

echo "=== Backup ==="
check kubectl -n cell-alpha exec statefulset/gitlab-cell-alpha-gitaly -- gitaly-backup create --server-side --path "gs://${GCP_PROJECT_ID}-alpha-artifacts/gitaly-backups/e2e-test"
check gsutil ls "gs://${GCP_PROJECT_ID}-alpha-artifacts/gitaly-backups/e2e-test/" >/dev/null

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
exit $((FAIL > 0 ? 1 : 0))
```

---

## API Reference

### GCP (`@intentius/chant-lexicon-gcp`)

| Type | Name | Source |
|------|------|--------|
| Composite | `VpcNetwork` | `lexicons/gcp/src/composites/vpc-network.ts` |
| Composite | `GkeCluster` | `lexicons/gcp/src/composites/gke-cluster.ts` |
| Composite | `CloudSqlInstance` | `lexicons/gcp/src/composites/cloud-sql-instance.ts` |
| Composite | `GcsBucket` | `lexicons/gcp/src/composites/gcs-bucket.ts` |
| Composite | `MemorystoreInstance` | `lexicons/gcp/src/composites/memorystore-instance.ts` (NEW) |
| Composite | `DNSZone` | `lexicons/gcp/src/composites/dns-zone.ts` (NEW) |
| Composite | `KMSEncryption` | `lexicons/gcp/src/composites/kms-encryption.ts` (NEW) |
| Composite | `PrivateService` | `lexicons/gcp/src/composites/private-service.ts` |
| Resource | `GCPServiceAccount` | `lexicons/gcp/src/generated/index.ts` |
| Resource | `IAMPolicyMember` | `lexicons/gcp/src/generated/index.ts` |
| Resource | `SecretManagerSecret` | `lexicons/gcp/src/generated/index.ts` |
| Resource | `SecretManagerSecretVersion` | `lexicons/gcp/src/generated/index.ts` |
| Resource | `SQLInstance` | `lexicons/gcp/src/generated/index.ts` |
| Resource | `NodePool` | `lexicons/gcp/src/generated/index.ts` |

### K8s (`@intentius/chant-lexicon-k8s`)

| Type | Name | Source |
|------|------|--------|
| Composite | `NamespaceEnv` | `lexicons/k8s/src/composites/namespace-env.ts` |
| Composite | `WorkloadIdentityServiceAccount` | `lexicons/k8s/src/composites/` |
| Resource | `NetworkPolicy` | `lexicons/k8s/src/generated/index.ts` |
| Resource | `Deployment` | `lexicons/k8s/src/generated/index.ts` |
| Resource | `Service` | `lexicons/k8s/src/generated/index.ts` |
| Resource | `ServiceAccount` | `lexicons/k8s/src/generated/index.ts` |
| Resource | `ConfigMap` | `lexicons/k8s/src/generated/index.ts` |
| Resource | `PodDisruptionBudget` | `lexicons/k8s/src/generated/index.ts` |
| Resource | `HorizontalPodAutoscaler` | `lexicons/k8s/src/generated/index.ts` |
| CR (via `createResource`) | `ExternalSecret` | `K8s::ExternalSecrets::ExternalSecret` |
| CR (via `createResource`) | `ClusterSecretStore` | `K8s::ExternalSecrets::ClusterSecretStore` |
| CR (via `createResource`) | `ClusterIssuer` | `K8s::CertManager::ClusterIssuer` |

### Core (`@intentius/chant`)

| Type | Name | Source |
|------|------|--------|
| Factory | `createResource` | `packages/core/src/runtime.ts` |

### Helm (`@intentius/chant-lexicon-helm`)

| Type | Name | Source |
|------|------|--------|
| Resource | `Chart` | `lexicons/helm/src/resources.ts` |
| Resource | `Values` | `lexicons/helm/src/resources.ts` |
| Property | `HelmDependency` | `lexicons/helm/src/resources.ts` |
| Intrinsic | `values()` | `lexicons/helm/src/intrinsics.ts` |

### GitLab (`@intentius/chant-lexicon-gitlab`)

| Type | Name | Source |
|------|------|--------|
| Resource | `Job` | `lexicons/gitlab/src/generated/index.ts` |
| Property | `Image` | `lexicons/gitlab/src/generated/index.ts` |
| Property | `Rule` | `lexicons/gitlab/src/generated/index.ts` |
| Property | `Parallel` | `lexicons/gitlab/src/generated/index.ts` |

---

## Execution Order

0. **Prerequisite**: Create 3 new GCP composites (`MemorystoreInstance`, `DNSZone`, `KMSEncryption`) in `lexicons/gcp/src/composites/` and register in `composites/index.ts`. Build Topology Service image from `gitlab-org/cells/topology-service` source.
1. Scaffold: `package.json`, `chant.config.json`, `.env.example`
2. Config: `src/config.ts`
3. GCP: networking → cluster → databases → cache → storage → dns → encryption → iam → secrets → outputs
4. System K8s: namespace → ingress-controller → cert-manager → external-secrets → topology-service → monitoring → gitlab-runner
5. Cell K8s: factory → index
6. Helm: gitlab-cell.ts
7. Pipeline: index.ts
8. Scripts: `bootstrap.sh`, `deploy-cells.sh`, `load-outputs.sh`, `e2e-test.sh`, `teardown.sh`
9. README.md

## Verification

### Local (no GCP required)

```bash
cd examples/gcp-gitlab-cells
npm install
npm run build      # all 4 lexicons
npm run lint       # no violations
```

Expected outputs:
- `config.yaml` — GKE cluster + runner node pool, Cloud SQL ×3 + read replicas, Memorystore ×4, GCS ×4 with lifecycle, VPC, DNS, KMS, IAM, Secret Manager
- `k8s.yaml` — system namespace (ingress + HPA, cert-manager ClusterIssuer, ESO ClusterSecretStore, runner, topology svc, monitoring with remote_write) + 2 cell namespaces with NetworkPolicies and ExternalSecrets
- `gitlab-cell/` — Chart.yaml with gitlab dependency, values.yaml with full production config (PgBouncer, Sidekiq queue isolation, read replica load balancing, TLS, split Redis, SMTP, registry, Gitaly PVC)
- `.gitlab-ci.yml` — 9-stage pipeline with canary deployment, runner registration, E2E smoke test, backup, and org migration

### E2E (requires GCP project)

```bash
npm run bootstrap                 # one-time: GKE cluster + Config Connector
npm run deploy                    # full stack (~30 min, first deploy ~45 min with db:migrate)
bash scripts/e2e-test.sh          # validates 10 areas
npm run teardown                  # clean up
```

---

## Scripts

### `scripts/bootstrap.sh`

One-time GKE cluster setup. Pattern: `k8s-gke-microservice/scripts/bootstrap.sh`.

```bash
#!/usr/bin/env bash
set -euo pipefail

source .env

echo "Creating GKE cluster with Config Connector..."
gcloud container clusters create "$CLUSTER_NAME" \
  --region "$GCP_REGION" \
  --project "$GCP_PROJECT_ID" \
  --machine-type "$MACHINE_TYPE" \
  --num-nodes "$MIN_NODE_COUNT" \
  --max-nodes "$MAX_NODE_COUNT" \
  --enable-autoscaling \
  --workload-pool="${GCP_PROJECT_ID}.svc.id.goog" \
  --addons ConfigConnector \
  --release-channel regular \
  --disk-size "${NODE_DISK_SIZE_GB:-200}" \
  --enable-ip-alias

echo "Creating Config Connector service account..."
CC_SA="config-connector@${GCP_PROJECT_ID}.iam.gserviceaccount.com"
gcloud iam service-accounts create config-connector \
  --project "$GCP_PROJECT_ID" \
  --display-name "Config Connector SA" || true

for ROLE in roles/editor roles/iam.securityAdmin roles/dns.admin; do
  gcloud projects add-iam-policy-binding "$GCP_PROJECT_ID" \
    --member "serviceAccount:${CC_SA}" \
    --role "$ROLE" --condition=None
done

echo "Binding Config Connector SA to Workload Identity..."
gcloud iam service-accounts add-iam-policy-binding "$CC_SA" \
  --member "serviceAccount:${GCP_PROJECT_ID}.svc.id.goog[cnrm-system/cnrm-controller-manager]" \
  --role roles/iam.workloadIdentityUser

echo "Configuring Config Connector..."
kubectl apply -f - <<EOF
apiVersion: core.cnrm.cloud.google.com/v1beta1
kind: ConfigConnectorContext
metadata:
  name: configconnectorcontext.core.cnrm.cloud.google.com
  namespace: default
spec:
  googleServiceAccount: "$CC_SA"
EOF

echo "Bootstrap complete. Run 'npm run deploy' to deploy infrastructure."
```

### `scripts/load-outputs.sh`

Reads Config Connector resource statuses and generates per-cell Helm values files.

```bash
#!/usr/bin/env bash
set -euo pipefail

source .env

echo "Reading Config Connector outputs..."

# Cell list derived from Config Connector resources (not K8s namespaces —
# namespaces may not exist yet during first deploy). Pattern: all Cloud SQL
# instances named gitlab-<cell>-db.
CELLS=$(kubectl get sqlinstances -o jsonpath='{.items[*].metadata.name}' | tr ' ' '\n' | grep '^gitlab-.*-db$' | sed 's/^gitlab-//;s/-db$//')

# Cell identity mapping (from config.ts — static, not runtime state)
# Generated by build step: chant build writes cells.json with cellId + sequenceOffset
# Fallback: hardcoded from config.ts defaults
declare -A CELL_IDS=( ["alpha"]=1 ["beta"]=2 )
declare -A CELL_OFFSETS=( ["alpha"]=0 ["beta"]=1000000 )

for CELL in $CELLS; do
  PG_IP=$(kubectl get sqlinstances "gitlab-${CELL}-db" -o jsonpath='{.status.ipAddresses[?(@.type=="PRIVATE")].ipAddress}')
  REPLICA_IP=$(kubectl get sqlinstances "gitlab-${CELL}-db-replica-0" -o jsonpath='{.status.ipAddresses[?(@.type=="PRIVATE")].ipAddress}' 2>/dev/null || echo "")

  # Read Redis hosts
  REDIS_PERSISTENT=$(kubectl get redisinstances "gitlab-${CELL}-persistent" -o jsonpath='{.status.host}')
  REDIS_CACHE=$(kubectl get redisinstances "gitlab-${CELL}-cache" -o jsonpath='{.status.host}')

  # Read Cloud SQL password from CC-generated K8s secret and push to Secret Manager
  PG_PASSWORD=$(kubectl get secret "gitlab-${CELL}-db-sql-instance-credentials" -o jsonpath='{.data.password}' | base64 -d)
  echo -n "$PG_PASSWORD" | gcloud secrets versions add "gitlab-${CELL}-db-password" --data-file=- --project "$GCP_PROJECT_ID"

  # Generate per-cell values file
  cat > "values-${CELL}.yaml" <<VALS
cellDomain: "${CELL}.${DOMAIN}"
cellName: "${CELL}"
cellId: ${CELL_IDS[$CELL]:-0}
sequenceOffset: ${CELL_OFFSETS[$CELL]:-0}
pgHost: "${PG_IP}"
pgReadReplicaHost: "${REPLICA_IP}"
redisPersistentHost: "${REDIS_PERSISTENT}"
redisCacheHost: "${REDIS_CACHE}"
projectId: "${GCP_PROJECT_ID}"
artifactsBucket: "${GCP_PROJECT_ID}-${CELL}-artifacts"
registryBucket: "${GCP_PROJECT_ID}-${CELL}-registry"
smtpAddress: "${SMTP_ADDRESS}"
smtpPort: ${SMTP_PORT}
smtpUser: "${SMTP_USER}"
smtpDomain: "${SMTP_DOMAIN}"
VALS
  echo "Generated values-${CELL}.yaml"
done

# Read ingress IP (may not be available until after system namespace deploy)
INGRESS_IP=$(kubectl -n system get svc ingress-nginx-controller -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || echo "PENDING")
echo "INGRESS_IP=${INGRESS_IP}" >> .env
echo "Ingress IP: ${INGRESS_IP}"
```

### `scripts/deploy-cells.sh`

Helm install per cell, canary first.

```bash
#!/usr/bin/env bash
set -euo pipefail

source .env

# Deploy canary cells first
for VALUES_FILE in values-*.yaml; do
  CELL=$(basename "$VALUES_FILE" .yaml | sed 's/values-//')
  IS_CANARY=$(kubectl get ns "cell-${CELL}" -o jsonpath='{.metadata.labels.gitlab\.example\.com/canary}' 2>/dev/null || echo "false")
  if [ "$IS_CANARY" = "true" ]; then
    echo "Deploying canary cell: ${CELL}"
    helm upgrade --install "gitlab-cell-${CELL}" ./gitlab-cell/ \
      -n "cell-${CELL}" -f "$VALUES_FILE" --wait --timeout=900s
    kubectl -n "cell-${CELL}" rollout status "deploy/gitlab-cell-${CELL}-webservice-default" --timeout=300s
    echo "Canary cell ${CELL} deployed successfully"
  fi
done

# Deploy remaining cells
for VALUES_FILE in values-*.yaml; do
  CELL=$(basename "$VALUES_FILE" .yaml | sed 's/values-//')
  IS_CANARY=$(kubectl get ns "cell-${CELL}" -o jsonpath='{.metadata.labels.gitlab\.example\.com/canary}' 2>/dev/null || echo "false")
  if [ "$IS_CANARY" != "true" ]; then
    echo "Deploying cell: ${CELL}"
    helm upgrade --install "gitlab-cell-${CELL}" ./gitlab-cell/ \
      -n "cell-${CELL}" -f "$VALUES_FILE" --wait --timeout=900s
    kubectl -n "cell-${CELL}" rollout status "deploy/gitlab-cell-${CELL}-webservice-default" --timeout=300s
    echo "Cell ${CELL} deployed successfully"
  fi
done

echo "All cells deployed."
```

### `scripts/teardown.sh`

Reverse-order teardown.

```bash
#!/usr/bin/env bash
set -euo pipefail

source .env

echo "=== Tearing down cells ==="
for VALUES_FILE in values-*.yaml; do
  CELL=$(basename "$VALUES_FILE" .yaml | sed 's/values-//')
  echo "Uninstalling gitlab-cell-${CELL}..."
  helm uninstall "gitlab-cell-${CELL}" -n "cell-${CELL}" --wait || true
done

echo "=== Deleting K8s resources ==="
kubectl delete -f k8s.yaml --ignore-not-found || true

echo "=== Deleting Config Connector resources (GCP infra) ==="
kubectl delete -f config.yaml --ignore-not-found || true
echo "Waiting for Config Connector to delete GCP resources..."
sleep 60
kubectl wait --for=delete sqlinstances --all --timeout=600s 2>/dev/null || true
kubectl wait --for=delete redisinstances --all --timeout=300s 2>/dev/null || true

echo "=== Optional: Delete GKE cluster ==="
read -p "Delete GKE cluster '${CLUSTER_NAME:-gitlab-cells}'? [y/N] " CONFIRM
if [ "$CONFIRM" = "y" ]; then
  gcloud container clusters delete "${CLUSTER_NAME:-gitlab-cells}" \
    --region "${GCP_REGION:-us-central1}" --project "$GCP_PROJECT_ID" --quiet
fi

echo "Teardown complete."
```

---

## Operational Notes

### First Deploy Timing

- Config Connector resource creation: ~10-15 min (Cloud SQL is slowest)
- GitLab Helm first install: ~15-20 min (includes `db:migrate`)
- Use `--timeout=900s` for first deploy
- Total first deploy: ~45 min

### Upgrade / Rollback

1. Update `gitlabChartVersion` in config.ts, rebuild
2. Deploy canary first: `helm upgrade gitlab-cell-alpha ...`
3. Health check: `curl https://alpha.gitlab.example.com/-/health`
4. Rollback if needed: `helm rollback gitlab-cell-alpha 0`
5. Deploy remaining cells after canary passes

### Cell Decommissioning

1. Migrate all orgs via Topology Service
2. `helm uninstall gitlab-cell-<name> -n cell-<name>`
3. `kubectl delete ns cell-<name>`
4. Remove Config Connector resources (SQL, Redis, GCS)
5. Remove cell from `cells[]` in config.ts, rebuild
