// Deployment tier controls HA-related defaults.
//
// "starter" — non-HA, lower cost (~$400-500/mo for 2 cells). Safe starting point.
//   Upgrade path:
//     - pgHighAvailability, pgReadReplicas, pgBouncerEnabled: in-place via Config Connector
//       (60s maintenance window). Change here, run `npm run build && kubectl apply`.
//     - redisPersistentTier / redisCacheTier: NOT in-place. BASIC → STANDARD_HA requires
//       a new Memorystore instance. Run scripts/redis-cutover.sh for the migration.
//     - webserviceReplicas, topology replicas: zero-downtime rolling update via Helm.
//
// "production" — full HA, ~$1600-1800/mo for 2 cells.
export type DeploymentTier = "starter" | "production";

// Returns HA-related field defaults for the given tier.
// Spread into a CellConfig before adding cell-specific overrides.
export function cellTierDefaults(tier: DeploymentTier): Pick<
  CellConfig,
  "deploymentTier" | "pgHighAvailability" | "pgReadReplicas" | "pgBouncerEnabled"
  | "redisPersistentTier" | "redisCacheTier" | "webserviceReplicas"
> {
  if (tier === "production") {
    return {
      deploymentTier: "production",
      pgHighAvailability: true,
      pgReadReplicas: 1,
      pgBouncerEnabled: true,
      redisPersistentTier: "STANDARD_HA",
      redisCacheTier: "STANDARD_HA",
      webserviceReplicas: 3,
    };
  }
  return {
    deploymentTier: "starter",
    pgHighAvailability: false,
    pgReadReplicas: 0,
    pgBouncerEnabled: false,
    // BASIC tier — single-zone, no replication. Upgrade via redis-cutover.sh.
    redisPersistentTier: "BASIC",
    redisCacheTier: "BASIC",
    webserviceReplicas: 1,
  };
}

export interface SidekiqQueueConfig {
  name: string;
  queues: string[];
  replicas: number;
  cpuRequest: string;
  memoryRequest: string;
}

export interface CellConfig {
  name: string;
  cellId: number;
  sequenceOffset: number;
  deploymentTier: DeploymentTier;
  pgTier: string;
  pgDiskSize: number;
  pgHighAvailability: boolean;
  pgReadReplicas: number;
  pgBouncerEnabled: boolean;
  webserviceReplicas: number;
  redisPersistentTier: string;
  redisPersistentSizeGb: number;
  redisCacheTier: string;
  redisCacheSizeGb: number;
  bucketLocation: string;
  artifactRetentionDays: number;
  host: string;
  cpuQuota: string;
  memoryQuota: string;
  canary: boolean;
  gitalyDiskSizeGb: number;
  sidekiqQueues: SidekiqQueueConfig[];
  runnerConcurrency: number;
  runnerReplicas: number;
}

export const shared = {
  projectId: process.env.GCP_PROJECT_ID ?? "my-project",
  region: process.env.GCP_REGION ?? "us-central1",
  clusterName: "gitlab-cells",
  domain: process.env.DOMAIN ?? "gitlab.example.com",
  gitlabChartVersion: "8.7.2",
  machineType: process.env.MACHINE_TYPE ?? "e2-standard-8",
  minNodeCount: Number(process.env.MIN_NODE_COUNT ?? "3"),
  maxNodeCount: Number(process.env.MAX_NODE_COUNT ?? "20"),
  nodeDiskSizeGb: Number(process.env.NODE_DISK_SIZE_GB ?? "200"),
  releaseChannel: "REGULAR",
  nodeSubnetCidr: "10.0.0.0/20",
  podSubnetCidr: "10.4.0.0/14",
  serviceSubnetCidr: "10.8.0.0/20",
  ingressReplicas: Number(process.env.INGRESS_REPLICAS ?? "2"),
  ingressHpaEnabled: true,
  ingressHpaMaxReplicas: 10,
  smtpAddress: process.env.SMTP_ADDRESS ?? "smtp.sendgrid.net",
  smtpPort: Number(process.env.SMTP_PORT ?? "587"),
  smtpUser: process.env.SMTP_USER ?? "apikey",
  smtpDomain: process.env.SMTP_DOMAIN ?? "gitlab.example.com",
  letsEncryptEmail: process.env.LETSENCRYPT_EMAIL ?? "admin@example.com",
  runnerImage: "gitlab/gitlab-runner:v17.8.0",
  runnerReplicas: Number(process.env.RUNNER_REPLICAS ?? "2"),
  runnerConcurrency: Number(process.env.RUNNER_CONCURRENCY ?? "10"),
  runnerNodePoolEnabled: process.env.RUNNER_NODE_POOL_ENABLED === "true",
  runnerNodePoolMachineType: process.env.RUNNER_NODE_POOL_MACHINE_TYPE ?? "e2-standard-4",
  runnerNodePoolMaxCount: Number(process.env.RUNNER_NODE_POOL_MAX_COUNT ?? "10"),
  topologyDbTier: "db-custom-1-3840",
  // Enable HA for the topology DB. The topology service is in the critical path for
  // path-based routing — a zonal failure makes all org-slug routing unavailable.
  // Upgrade: set to true, run `npm run build && kubectl apply -f dist/config.yaml`
  // (in-place, ~60s maintenance window, no data loss).
  topologyDbHighAvailability: false,
  topologyServiceImage: process.env.TOPOLOGY_SERVICE_IMAGE ?? `gcr.io/${process.env.GCP_PROJECT_ID ?? "my-project"}/topology-service:latest`,
  cellRouterImage: process.env.CELL_ROUTER_IMAGE ?? `gcr.io/${process.env.GCP_PROJECT_ID ?? "my-project"}/cell-router:latest`,
  prometheusRemoteWriteUrl: process.env.PROMETHEUS_REMOTE_WRITE_URL ?? "",
  // Health score threshold below which the cell router fails over to the next available cell
  routerHealthThreshold: Number(process.env.ROUTER_HEALTH_THRESHOLD ?? "0.5"),
};

// Both cells start as "starter" tier (non-HA, ~$400-500/mo total).
// To upgrade individual fields to production-HA:
//   - pgHighAvailability, pgReadReplicas, pgBouncerEnabled → edit here + `npm run build && kubectl apply`
//   - redisPersistentTier / redisCacheTier → run scripts/redis-cutover.sh first (new instance required)
//   - webserviceReplicas → edit here + helm upgrade (zero-downtime rolling update)
export const cells: CellConfig[] = [
  {
    name: "alpha",
    cellId: 1,
    sequenceOffset: 0,
    // Starter tier: non-HA, single-zone. See cellTierDefaults() for production values.
    ...cellTierDefaults("starter"),
    pgTier: "db-custom-2-7680",  // production: "db-custom-4-15360"
    pgDiskSize: 50,
    redisPersistentSizeGb: 5,
    redisCacheSizeGb: 2,
    bucketLocation: "US",
    artifactRetentionDays: 90,
    host: `gitlab.alpha.${shared.domain}`,
    cpuQuota: "64",
    memoryQuota: "128Gi",
    canary: true,
    gitalyDiskSizeGb: 100,
    runnerConcurrency: 10,
    runnerReplicas: 1,
    sidekiqQueues: [
      { name: "urgent", queues: ["post_receive", "pipeline_processing"], replicas: 1, cpuRequest: "500m", memoryRequest: "1Gi" },
      { name: "default", queues: ["default", "mailers"], replicas: 1, cpuRequest: "250m", memoryRequest: "512Mi" },
    ],
  },
  {
    name: "beta",
    cellId: 2,
    sequenceOffset: 1000000,
    // Starter tier: non-HA, single-zone. See cellTierDefaults() for production values.
    ...cellTierDefaults("starter"),
    pgTier: "db-custom-2-7680",
    pgDiskSize: 20,
    redisPersistentSizeGb: 3,
    redisCacheSizeGb: 1,
    bucketLocation: "US",
    artifactRetentionDays: 30,
    host: `gitlab.beta.${shared.domain}`,
    cpuQuota: "64",
    memoryQuota: "128Gi",
    canary: false,
    gitalyDiskSizeGb: 50,
    runnerConcurrency: 10,
    runnerReplicas: 1,
    sidekiqQueues: [
      { name: "all-queues", queues: ["*"], replicas: 1, cpuRequest: "500m", memoryRequest: "1Gi" },
    ],
  },
];

// ── Safety assertions ─────────────────────────────────────
// These run at every `npm run build` to catch foot-guns before they reach GCP.

// cellId uniqueness — used as routing token prefix (glrt-cell_<id>_)
const _cellIds = cells.map(c => c.cellId);
if (new Set(_cellIds).size !== _cellIds.length)
  throw new Error(
    `Duplicate cellId detected: [${_cellIds.join(", ")}]. ` +
    `cellId is embedded in runner tokens (glrt-cell_<id>_) and must be unique per cell. ` +
    `See "Managing Cells" in README.md.`
  );

// sequenceOffset spacing — each cell needs 1M ID space; overlapping causes DB collisions
cells.forEach((a, i) => cells.forEach((b, j) => {
  if (i !== j && Math.abs(a.sequenceOffset - b.sequenceOffset) < 1_000_000)
    throw new Error(
      `Cells "${a.name}" and "${b.name}" sequenceOffsets are too close ` +
      `(${a.sequenceOffset} vs ${b.sequenceOffset}, need >= 1M gap). ` +
      `GitLab uses sequenceOffset to partition database row IDs across cells; ` +
      `overlapping ranges cause silent ID collisions. ` +
      `See "Managing Cells" in README.md.`
    );
}));
