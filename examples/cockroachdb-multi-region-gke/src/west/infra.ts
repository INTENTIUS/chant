// GCP infrastructure for the west region: GKE cluster, public DNS zone, and the
// two Workload Identity service accounts its pods use.
//
// GkeCrdbRegion emits all of it — cluster, managed node pool, the default pool
// GKE insists on creating, the zone, the ExternalDNS GSA with its WI binding
// and project-level dns.admin, and the CockroachDB GSA with its WI binding and
// object access to the shared backup bucket.

import { GkeCrdbRegion } from "@intentius/chant-lexicon-gcp";
import { BACKUP_BUCKET } from "../shared/config";
import { config } from "./config";

export const west = GkeCrdbRegion({
  region: config.region,
  clusterName: config.clusterName,
  network: "crdb-multi-region",
  subnetwork: `crdb-multi-region-${config.regionShort}-nodes`,
  domain: config.domain,
  project: config.projectId,
  crdbNamespace: config.namespace,
  masterCidr: config.masterCidr,
  backupBucket: BACKUP_BUCKET,
  nodeConfig: {
    machineType: config.machineType,
    maxNodeCount: config.maxNodeCount,
    diskSizeGb: 100,
  },
});
