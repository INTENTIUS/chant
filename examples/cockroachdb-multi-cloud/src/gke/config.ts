// GKE-specific configuration. Extends shared cluster config.

import { CRDB_CLUSTER, CRDB_DOMAIN } from "../shared/config";

export const config = {
  ...CRDB_CLUSTER,
  clusterName: process.env.GKE_CLUSTER_NAME ?? "gke-cockroachdb",
  projectId: process.env.GCP_PROJECT_ID ?? "my-project",
  region: "us-east4",
  namespace: "crdb-gke",
  locality: "cloud=gcp,region=us-east4",
  domain: `gke.${CRDB_DOMAIN}`,
  externalDnsGsaEmail: process.env.EXTERNAL_DNS_GSA_EMAIL ?? "gke-cockroachdb-dns@my-project.iam.gserviceaccount.com",
};
