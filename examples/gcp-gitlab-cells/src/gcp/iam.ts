import { GCPServiceAccount, IAMPolicyMember } from "@intentius/chant-lexicon-gcp";
import { cells, shared } from "../config";

// Per-cell Workload Identity service accounts
export const cellServiceAccounts = cells.map(c => new GCPServiceAccount({
  metadata: { name: `gitlab-${c.name}` },
  displayName: `GitLab cell ${c.name} workload identity`,
}));

// WI bindings: allow K8s SA to impersonate GCP SA
export const cellWiBindings = cells.map(c => new IAMPolicyMember({
  metadata: { name: `gitlab-${c.name}-wi` },
  member: `serviceAccount:${shared.projectId}.svc.id.goog[cell-${c.name}/${c.name}-sa]`,
  role: "roles/iam.workloadIdentityUser",
  resourceRef: {
    apiVersion: "iam.cnrm.cloud.google.com/v1beta1",
    kind: "IAMServiceAccount",
    name: `gitlab-${c.name}`,
  },
}));

// Per-cell GCS access: bucket-scoped objectAdmin (not project-level)
export const cellArtifactsBucketBindings = cells.map(c => new IAMPolicyMember({
  metadata: { name: `gitlab-${c.name}-artifacts-access` },
  member: `serviceAccount:gitlab-${c.name}@${shared.projectId}.iam.gserviceaccount.com`,
  role: "roles/storage.objectAdmin",
  resourceRef: {
    apiVersion: "storage.cnrm.cloud.google.com/v1beta1",
    kind: "StorageBucket",
    name: `${shared.projectId}-${c.name}-artifacts`,
  },
}));

export const cellRegistryBucketBindings = cells.map(c => new IAMPolicyMember({
  metadata: { name: `gitlab-${c.name}-registry-access` },
  member: `serviceAccount:gitlab-${c.name}@${shared.projectId}.iam.gserviceaccount.com`,
  role: "roles/storage.objectAdmin",
  resourceRef: {
    apiVersion: "storage.cnrm.cloud.google.com/v1beta1",
    kind: "StorageBucket",
    name: `${shared.projectId}-${c.name}-registry`,
  },
}));

// External Secrets Operator SA — reads from Secret Manager
export const esoServiceAccount = new GCPServiceAccount({
  metadata: { name: "gitlab-eso" },
  displayName: "External Secrets Operator",
});

export const esoWiBinding = new IAMPolicyMember({
  metadata: { name: "gitlab-eso-wi" },
  member: `serviceAccount:${shared.projectId}.svc.id.goog[system/external-secrets-sa]`,
  role: "roles/iam.workloadIdentityUser",
  resourceRef: {
    apiVersion: "iam.cnrm.cloud.google.com/v1beta1",
    kind: "IAMServiceAccount",
    name: "gitlab-eso",
  },
});

export const esoSecretAccessBinding = new IAMPolicyMember({
  metadata: { name: "gitlab-eso-secret-access" },
  member: `serviceAccount:gitlab-eso@${shared.projectId}.iam.gserviceaccount.com`,
  role: "roles/secretmanager.secretAccessor",
  resourceRef: {
    apiVersion: "resourcemanager.cnrm.cloud.google.com/v1beta1",
    kind: "Project",
    external: `projects/${shared.projectId}`,
  },
});

// cert-manager SA — needs dns.admin for DNS-01 ACME solver
export const certManagerServiceAccount = new GCPServiceAccount({
  metadata: { name: "gitlab-cert-manager" },
  displayName: "cert-manager DNS-01 solver",
});

export const certManagerWiBinding = new IAMPolicyMember({
  metadata: { name: "gitlab-cert-manager-wi" },
  member: `serviceAccount:${shared.projectId}.svc.id.goog[system/cert-manager]`,
  role: "roles/iam.workloadIdentityUser",
  resourceRef: {
    apiVersion: "iam.cnrm.cloud.google.com/v1beta1",
    kind: "IAMServiceAccount",
    name: "gitlab-cert-manager",
  },
});

export const certManagerDnsBinding = new IAMPolicyMember({
  metadata: { name: "gitlab-cert-manager-dns" },
  member: `serviceAccount:gitlab-cert-manager@${shared.projectId}.iam.gserviceaccount.com`,
  role: "roles/dns.admin",
  resourceRef: {
    apiVersion: "resourcemanager.cnrm.cloud.google.com/v1beta1",
    kind: "Project",
    external: `projects/${shared.projectId}`,
  },
});
