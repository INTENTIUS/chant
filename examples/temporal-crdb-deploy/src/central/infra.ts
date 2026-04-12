/**
 * Central region (us-central1) GCP infrastructure.
 *
 * Replaces: infra/cluster.ts + infra/dns.ts
 */

import { GkeCrdbRegion } from "@intentius/chant-lexicon-gcp";
import { GCP_PROJECT_ID, CRDB_DOMAIN, BACKUP_BUCKET } from "../shared/config";

export const central = GkeCrdbRegion({
  region: "us-central1",
  clusterName: "gke-crdb-central",
  network: "crdb-multi-region",
  subnetwork: "crdb-multi-region-central-nodes",
  domain: `central.${CRDB_DOMAIN}`,
  project: GCP_PROJECT_ID,
  crdbNamespace: "crdb-central",
  masterCidr: "172.17.0.0/28",
  nodeConfig: {
    machineType: "n2-standard-2",
    diskSizeGb: 100,
    nodeCount: 1,
    maxNodeCount: 3,
  },
  backupBucket: BACKUP_BUCKET,
});

export const cluster = central.cluster;
export const nodePool = central.nodePool;
export const defaultPool = central.defaultPool;
export const dnsZone = central.dnsZone;
export const dnsGsa = central.dnsGsa;
export const dnsWiBinding = central.dnsWiBinding;
export const dnsAdminBinding = central.dnsAdminBinding;
export const crdbGsa = central.crdbGsa;
export const crdbWiBinding = central.crdbWiBinding;
export const crdbBackupBinding = (central as Record<string, unknown>).crdbBackupBinding;
