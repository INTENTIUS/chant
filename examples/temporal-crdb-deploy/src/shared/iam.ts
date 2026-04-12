/**
 * Shared IAM — GCP service accounts and bindings that span all 3 regions.
 *
 * Per-region resources (DNS GSA, CRDB GSA, WI bindings) live in each region's infra.ts
 * via GkeCrdbRegion. This file handles the two cross-region concerns:
 *
 *   • External Secrets Operator (ESO) GSA — one SA, three WI bindings (one per cluster)
 *   • CRDB backup bucket bindings — granting each region's CRDB GSA access to the bucket
 *     is done via GkeCrdbRegion when backupBucket is provided
 */

import { GCPServiceAccount, IAMPolicyMember } from "@intentius/chant-lexicon-gcp";
import { GCP_PROJECT_ID, BACKUP_BUCKET } from "./config";

// ── External Secrets Operator ─────────────────────────────────────────────────
// One GSA per project — all three clusters share it via separate WI bindings.

export const esoServiceAccount = new GCPServiceAccount({
  metadata: {
    name: "crdb-eso",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  displayName: "CockroachDB External Secrets Operator",
});

// Each cluster gets its own WI binding (kube-system/external-secrets-sa → crdb-eso GSA).
const ESO_REGIONS = ["east", "central", "west"] as const;

export const esoWiBindings = ESO_REGIONS.map(region => new IAMPolicyMember({
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

// Secret Manager read access so ESO can sync certs into K8s Secrets.
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

// Suppress: array-based exports are required here (one binding per region)
export { BACKUP_BUCKET };
