// Central region (us-central1). A secondary: joins the cluster east
// initialised, so it neither runs `cockroach init` nor generates certs.

import { CRDB_CLUSTER, CRDB_DOMAIN, GCP_PROJECT_ID, INTERNAL_DOMAIN, REGIONS } from "../shared/config";

export const config = {
  ...CRDB_CLUSTER,
  clusterName: "gke-crdb-central",
  projectId: GCP_PROJECT_ID,
  region: REGIONS.central.region,
  namespace: "crdb-central",
  locality: "cloud=gcp,region=us-central1",
  regionShort: "central",
  domain: `central.${CRDB_DOMAIN}`,
  internalDomain: `central.${INTERNAL_DOMAIN}`,

  machineType: "e2-standard-2",
  maxNodeCount: 1,
  // /28, unique per cluster, must not overlap the node or pod CIDRs.
  masterCidr: "172.16.1.0/28",

  // Both service accounts are created by this region's GkeCrdbRegion, so their
  // emails follow from the cluster name.
  externalDnsGsaEmail: `gke-crdb-central-dns@${GCP_PROJECT_ID}.iam.gserviceaccount.com`,
  crdbGsaEmail: `gke-crdb-central-crdb@${GCP_PROJECT_ID}.iam.gserviceaccount.com`,
};
