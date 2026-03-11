// CockroachDB Workload Identity: per-region GCP SAs with GCS backup bucket access.

import { GCPServiceAccount, IAMPolicyMember } from "@intentius/chant-lexicon-gcp";
import { GCP_PROJECT_ID } from "./config";

const REGIONS = ["east", "central", "west"] as const;

export const crdbServiceAccounts = REGIONS.map(region => new GCPServiceAccount({
  metadata: {
    name: `gke-crdb-${region}-crdb`,
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  displayName: `CockroachDB ${region} workload identity`,
}));

export const crdbWiBindings = REGIONS.map(region => new IAMPolicyMember({
  metadata: {
    name: `gke-crdb-${region}-crdb-wi`,
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  member: `serviceAccount:${GCP_PROJECT_ID}.svc.id.goog[crdb-${region}/cockroachdb]`,
  role: "roles/iam.workloadIdentityUser",
  resourceRef: {
    apiVersion: "iam.cnrm.cloud.google.com/v1beta1",
    kind: "IAMServiceAccount",
    name: `gke-crdb-${region}-crdb`,
  },
}));

export const crdbBucketBindings = REGIONS.map(region => new IAMPolicyMember({
  metadata: {
    name: `gke-crdb-${region}-crdb-backup`,
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  member: `serviceAccount:gke-crdb-${region}-crdb@${GCP_PROJECT_ID}.iam.gserviceaccount.com`,
  role: "roles/storage.objectAdmin",
  resourceRef: {
    apiVersion: "storage.cnrm.cloud.google.com/v1beta1",
    kind: "StorageBucket",
    name: `${GCP_PROJECT_ID}-crdb-backups`,
  },
}));
