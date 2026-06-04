/**
 * Deploy phases after the Argo split.
 *
 * Argo CD now owns the declarative apply phases — the workflow bootstraps the
 * Argo Applications once (APPLY_ARGO) and then *waits* for Argo to converge
 * (SYNC_*). The old per-region apply phases (APPLY_SHARED_INFRA,
 * APPLY_REGIONAL_INFRA, INSTALL_ESO, APPLY_K8S) and the StatefulSet rollout wait
 * (WAIT_STATEFULSETS) collapse into the SYNC_* waits, which resolve on Argo
 * Health=Healthy. Temporal keeps only the genuinely procedural phases (DNS
 * gates, certs, secrets, init, region topology, backups).
 */
export enum Phase {
  BUILD = 'BUILD',
  APPLY_ARGO_INFRA = 'APPLY_ARGO_INFRA',
  SYNC_INFRA = 'SYNC_INFRA',
  WAIT_DNS_DELEGATION = 'WAIT_DNS_DELEGATION',
  CONFIGURE_KUBECTL = 'CONFIGURE_KUBECTL',
  GENERATE_CERTS = 'GENERATE_CERTS',
  APPLY_ARGO_WORKLOAD = 'APPLY_ARGO_WORKLOAD',
  SYNC_ESO = 'SYNC_ESO',
  PUSH_SECRETS = 'PUSH_SECRETS',
  SYNC_K8S = 'SYNC_K8S',
  WAIT_DNS_RECORDS = 'WAIT_DNS_RECORDS',
  INIT_CRDB = 'INIT_CRDB',
  CONFIGURE_REGIONS = 'CONFIGURE_REGIONS',
  SETUP_BACKUP = 'SETUP_BACKUP',
  COMPLETE = 'COMPLETE',
}

/** Argo Application names the workflow waits on (declared in src/argo). */
export const ARGO_APPS = {
  /** Shared + regional GCP infra (Config Connector) on the mgmt cluster. */
  infra: ['shared-infra', 'east-infra', 'central-infra', 'west-infra'],
  /** External Secrets Operator (Helm) per workload cluster. */
  eso: ['east-eso', 'central-eso', 'west-eso'],
  /** Per-region CockroachDB workload manifests. */
  k8s: ['east-crdb', 'central-crdb', 'west-crdb'],
} as const;

export interface DeployParams {
  gcpProjectId: string;
  crdbDomain: string;
  certsDir?: string;
}

export type Region = 'east' | 'central' | 'west';

export const REGION_CONFIG: Record<Region, { gkeCluster: string; gkeRegion: string; namespace: string }> = {
  east:    { gkeCluster: 'gke-crdb-east',    gkeRegion: 'us-east4',    namespace: 'crdb-east' },
  central: { gkeCluster: 'gke-crdb-central', gkeRegion: 'us-central1', namespace: 'crdb-central' },
  west:    { gkeCluster: 'gke-crdb-west',    gkeRegion: 'us-west1',    namespace: 'crdb-west' },
};

/**
 * Search attribute keys declared in src/temporal.ts via TemporalCloudStack.
 *
 * Usage in the workflow:
 *   workflow.upsertSearchAttributes({
 *     [SEARCH_ATTRS.DeployPhase]: [Phase.SYNC_INFRA],
 *     [SEARCH_ATTRS.GcpProject]:  [params.gcpProjectId],
 *   });
 *
 * This lets the Temporal Cloud UI workflow list act as a deployment dashboard:
 *   • Filter by DeployPhase to see all workflows in WAIT_DNS_DELEGATION
 *   • Filter by DeployRegion to see which regions are active
 */
export const SEARCH_ATTRS = {
  GcpProject:   'GcpProject',
  CrdbDomain:   'CrdbDomain',
  DeployPhase:  'DeployPhase',
  DeployRegion: 'DeployRegion',
} as const;
