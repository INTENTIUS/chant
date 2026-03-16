// External Secrets Operator Workload Identity: GCP SA with Secret Manager access.

import { GCPServiceAccount, IAMPolicyMember } from "@intentius/chant-lexicon-gcp";
import { GCP_PROJECT_ID } from "./config";

const REGIONS = ["east", "central", "west"] as const;

export const esoServiceAccount = new GCPServiceAccount({
  metadata: {
    name: "crdb-eso",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  displayName: "CockroachDB External Secrets Operator",
});

export const esoWiBindings = REGIONS.map(region => new IAMPolicyMember({
  metadata: {
    name: `crdb-eso-wi-${region}`,
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  member: `serviceAccount:${GCP_PROJECT_ID}.svc.id.goog[kube-system/external-secrets-sa]`,
  role: "roles/iam.workloadIdentityUser",
  resourceRef: {
    apiVersion: "iam.cnrm.cloud.google.com/v1beta1",
    kind: "IAMServiceAccount",
    name: "crdb-eso",
  },
}));

export const esoSecretAccessBinding = new IAMPolicyMember({
  metadata: {
    name: "crdb-eso-secret-access",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  member: `serviceAccount:crdb-eso@${GCP_PROJECT_ID}.iam.gserviceaccount.com`,
  role: "roles/secretmanager.secretAccessor",
  resourceRef: {
    apiVersion: "resourcemanager.cnrm.cloud.google.com/v1beta1",
    kind: "Project",
    external: `projects/${GCP_PROJECT_ID}`,
  },
});
