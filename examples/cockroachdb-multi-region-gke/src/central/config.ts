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
  // Both service accounts are created by this same stack, so their emails
  // follow from the cluster name — there was never anything to override.
  externalDnsGsaEmail: `gke-crdb-central-dns@${GCP_PROJECT_ID}.iam.gserviceaccount.com`,
  crdbGsaEmail: `gke-crdb-central-crdb@${GCP_PROJECT_ID}.iam.gserviceaccount.com`,
};
