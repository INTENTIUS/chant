// West region (us-west1). A secondary: joins the cluster east initialised, so
// it neither runs `cockroach init` nor generates certs.

import { CRDB_CLUSTER, CRDB_DOMAIN, GCP_PROJECT_ID, INTERNAL_DOMAIN, REGIONS } from "../shared/config";

export const config = {
  ...CRDB_CLUSTER,
  clusterName: "gke-crdb-west",
  projectId: GCP_PROJECT_ID,
  region: REGIONS.west.region,
  namespace: "crdb-west",
  locality: "cloud=gcp,region=us-west1",
  regionShort: "west",
  domain: `west.${CRDB_DOMAIN}`,
  internalDomain: `west.${INTERNAL_DOMAIN}`,

  machineType: "e2-standard-2",
  maxNodeCount: 1,
  // /28, unique per cluster, must not overlap the node or pod CIDRs.
  masterCidr: "172.16.2.0/28",

  // Both service accounts are created by this region's GkeCrdbRegion, so their
  // emails follow from the cluster name.
  externalDnsGsaEmail: `gke-crdb-west-dns@${GCP_PROJECT_ID}.iam.gserviceaccount.com`,
  crdbGsaEmail: `gke-crdb-west-crdb@${GCP_PROJECT_ID}.iam.gserviceaccount.com`,
};
