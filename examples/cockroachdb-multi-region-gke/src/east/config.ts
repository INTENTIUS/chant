// East region (us-east4) configuration. Extends shared cluster config.

import { CRDB_CLUSTER, CRDB_DOMAIN, GCP_PROJECT_ID } from "../shared/config";

export const config = {
  ...CRDB_CLUSTER,
  clusterName: "gke-crdb-east",
  projectId: GCP_PROJECT_ID,
  region: "us-east4",
  namespace: "crdb-east",
  locality: "cloud=gcp,region=us-east4",
  regionShort: "east",
  domain: `east.${CRDB_DOMAIN}`,
  // Both service accounts are created by this same stack, so their emails
  // follow from the cluster name — there was never anything to override.
  externalDnsGsaEmail: `gke-crdb-east-dns@${GCP_PROJECT_ID}.iam.gserviceaccount.com`,
  crdbGsaEmail: `gke-crdb-east-crdb@${GCP_PROJECT_ID}.iam.gserviceaccount.com`,
};
