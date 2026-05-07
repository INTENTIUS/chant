/**
 * East region (us-east4) GCP infrastructure.
 *
 * GkeCrdbRegion creates: GKE cluster + node pools, public DNS zone,
 * ExternalDNS GSA + WI bindings, CRDB GSA + WI binding, and (via backupBucket)
 * the GCS access binding for backups.
 *
 * Replaces: infra/cluster.ts + infra/dns.ts
 */

import { GkeCrdbRegion } from "@intentius/chant-lexicon-gcp";
import { GCP_PROJECT_ID, CRDB_DOMAIN, BACKUP_BUCKET } from "../shared/config";

export const east = GkeCrdbRegion({
  region: "us-east4",
  clusterName: "gke-crdb-east",
  network: "crdb-multi-region",
  subnetwork: "crdb-multi-region-east-nodes",
  domain: `east.${CRDB_DOMAIN}`,
  project: GCP_PROJECT_ID,
  crdbNamespace: "crdb-east",
  masterCidr: "172.16.0.0/28",
  nodeConfig: {
    machineType: "n2-standard-2",
    diskSizeGb: 100,
    nodeCount: 1,
    maxNodeCount: 3,
  },
  backupBucket: BACKUP_BUCKET,
});
