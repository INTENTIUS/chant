// West region (us-west1) configuration. Extends shared cluster config.

import { CRDB_CLUSTER, CRDB_DOMAIN, GCP_PROJECT_ID } from "../shared/config";

export const config = {
  ...CRDB_CLUSTER,
  clusterName: "gke-crdb-west",
  projectId: GCP_PROJECT_ID,
  region: "us-west1",
  namespace: "crdb-west",
  locality: "cloud=gcp,region=us-west1",
  regionShort: "west",
  domain: `west.${CRDB_DOMAIN}`,
  // Both service accounts are created by this same stack, so their emails
  // follow from the cluster name — there was never anything to override.
  externalDnsGsaEmail: `gke-crdb-west-dns@${GCP_PROJECT_ID}.iam.gserviceaccount.com`,
  crdbGsaEmail: `gke-crdb-west-crdb@${GCP_PROJECT_ID}.iam.gserviceaccount.com`,
};
