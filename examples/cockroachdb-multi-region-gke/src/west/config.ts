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
  externalDnsGsaEmail: process.env.EXTERNAL_DNS_GSA_EMAIL_WEST ?? `gke-crdb-west-dns@${GCP_PROJECT_ID}.iam.gserviceaccount.com`,
};
