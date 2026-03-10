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
  externalDnsGsaEmail: process.env.EXTERNAL_DNS_GSA_EMAIL_EAST ?? `gke-crdb-east-dns@${GCP_PROJECT_ID}.iam.gserviceaccount.com`,
};
