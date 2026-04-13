/**
 * West region (us-west1) GCP infrastructure.
 *
 * Replaces: infra/cluster.ts + infra/dns.ts
 */

import { GkeCrdbRegion } from "@intentius/chant-lexicon-gcp";
import { GCP_PROJECT_ID, CRDB_DOMAIN, BACKUP_BUCKET } from "../shared/config";

export const west = GkeCrdbRegion({
  region: "us-west1",
  clusterName: "gke-crdb-west",
  network: "crdb-multi-region",
  subnetwork: "crdb-multi-region-west-nodes",
  domain: `west.${CRDB_DOMAIN}`,
  project: GCP_PROJECT_ID,
  crdbNamespace: "crdb-west",
  masterCidr: "172.18.0.0/28",
  nodeConfig: {
    machineType: "n2-standard-2",
    diskSizeGb: 100,
    nodeCount: 1,
    maxNodeCount: 3,
  },
  backupBucket: BACKUP_BUCKET,
});

export const cluster = west.cluster;
export const nodePool = west.nodePool;
export const defaultPool = west.defaultPool;
export const dnsZone = west.dnsZone;
export const dnsGsa = west.dnsGsa;
export const dnsWiBinding = west.dnsWiBinding;
export const dnsAdminBinding = west.dnsAdminBinding;
export const crdbGsa = west.crdbGsa;
export const crdbWiBinding = west.crdbWiBinding;
export const crdbBackupBinding = (west as Record<string, unknown>).crdbBackupBinding;
