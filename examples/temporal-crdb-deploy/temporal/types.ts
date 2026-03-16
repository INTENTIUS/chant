export enum Phase {
  BUILD = 'BUILD',
  APPLY_SHARED_INFRA = 'APPLY_SHARED_INFRA',
  APPLY_REGIONAL_INFRA = 'APPLY_REGIONAL_INFRA',
  WAIT_DNS_DELEGATION = 'WAIT_DNS_DELEGATION',
  CONFIGURE_KUBECTL = 'CONFIGURE_KUBECTL',
  GENERATE_CERTS = 'GENERATE_CERTS',
  INSTALL_ESO = 'INSTALL_ESO',
  PUSH_SECRETS = 'PUSH_SECRETS',
  APPLY_K8S = 'APPLY_K8S',
  WAIT_DNS_RECORDS = 'WAIT_DNS_RECORDS',
  WAIT_STATEFULSETS = 'WAIT_STATEFULSETS',
  INIT_CRDB = 'INIT_CRDB',
  CONFIGURE_REGIONS = 'CONFIGURE_REGIONS',
  SETUP_BACKUP = 'SETUP_BACKUP',
  COMPLETE = 'COMPLETE',
}

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
