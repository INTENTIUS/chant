// East region (us-east4). The primary: this is the region that runs
// `cockroach init` and the one the multi-region topology is anchored on.

import { CRDB_CLUSTER, CRDB_DOMAIN, GCP_PROJECT_ID, INTERNAL_DOMAIN, REGIONS } from "../shared/config";

export const config = {
  ...CRDB_CLUSTER,
  clusterName: "gke-crdb-east",
  projectId: GCP_PROJECT_ID,
  region: REGIONS.east.region,
  namespace: "crdb-east",
  locality: "cloud=gcp,region=us-east4",
  regionShort: "east",
  domain: `east.${CRDB_DOMAIN}`,
  internalDomain: `east.${INTERNAL_DOMAIN}`,

  // e2-standard-2 has been out of capacity in every us-east4 zone; n2 is the
  // same 2 vCPU / 8 GiB shape.
  machineType: "n2-standard-2",
  maxNodeCount: 3,
  // /28, unique per cluster, must not overlap the node or pod CIDRs.
  masterCidr: "172.16.0.0/28",

  // Both service accounts are created by this region's GkeCrdbRegion, so their
  // emails follow from the cluster name.
  externalDnsGsaEmail: `gke-crdb-east-dns@${GCP_PROJECT_ID}.iam.gserviceaccount.com`,
  crdbGsaEmail: `gke-crdb-east-crdb@${GCP_PROJECT_ID}.iam.gserviceaccount.com`,
};
