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
  runnerImage: "gitlab/gitlab-runner:v17.8",
  runnerReplicas: Number(process.env.RUNNER_REPLICAS ?? "2"),
  runnerConcurrency: Number(process.env.RUNNER_CONCURRENCY ?? "10"),
  runnerNodePoolEnabled: process.env.RUNNER_NODE_POOL_ENABLED === "true",
  runnerNodePoolMachineType: process.env.RUNNER_NODE_POOL_MACHINE_TYPE ?? "e2-standard-4",
  runnerNodePoolMaxCount: Number(process.env.RUNNER_NODE_POOL_MAX_COUNT ?? "10"),
  topologyDbTier: "db-custom-1-3840",
  topologyServiceImage: process.env.TOPOLOGY_SERVICE_IMAGE ?? `gcr.io/${process.env.GCP_PROJECT_ID ?? "my-project"}/topology-service:latest`,
  prometheusRemoteWriteUrl: process.env.PROMETHEUS_REMOTE_WRITE_URL ?? "",
  // Health score threshold below which the cell router fails over to the next available cell
  routerHealthThreshold: Number(process.env.ROUTER_HEALTH_THRESHOLD ?? "0.5"),
};

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
    host: `alpha.${shared.domain}`,
    cpuQuota: "64",
    memoryQuota: "128Gi",
    canary: true,
    gitalyDiskSizeGb: 100,
    runnerConcurrency: 10,
    runnerReplicas: 1,
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
    host: `beta.${shared.domain}`,
    cpuQuota: "48",
    memoryQuota: "96Gi",
    canary: false,
    gitalyDiskSizeGb: 50,
    runnerConcurrency: 10,
    runnerReplicas: 1,
    sidekiqQueues: [
      { name: "all-queues", queues: ["*"], replicas: 2, cpuRequest: "500m", memoryRequest: "1Gi" },
    ],
  },
];
