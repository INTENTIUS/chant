// Central region (us-central1) configuration. Extends shared cluster config.

import { CRDB_CLUSTER, CRDB_DOMAIN, GCP_PROJECT_ID } from "../shared/config";

export const config = {
  ...CRDB_CLUSTER,
  clusterName: "gke-crdb-central",
  projectId: GCP_PROJECT_ID,
  region: "us-central1",
  namespace: "crdb-central",
  locality: "cloud=gcp,region=us-central1",
  regionShort: "central",
  domain: `central.${CRDB_DOMAIN}`,
  externalDnsGsaEmail: process.env.EXTERNAL_DNS_GSA_EMAIL_CENTRAL ?? `gke-crdb-central-dns@${GCP_PROJECT_ID}.iam.gserviceaccount.com`,
};
