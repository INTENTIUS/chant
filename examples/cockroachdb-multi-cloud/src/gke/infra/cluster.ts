// GCP infrastructure: GKE cluster + node pool + Workload Identity IAM bindings.
// Sized for CockroachDB: 3x e2-standard-4 (4 vCPU / 16 GiB) worker nodes.

import {
  GkeCluster,
  GCPServiceAccount,
  IAMPolicyMember,
} from "@intentius/chant-lexicon-gcp";
import { config } from "../config";

// ── GKE Cluster ────────────────────────────────────────────────────

export const { cluster, nodePool } = GkeCluster({
  name: "gke-cockroachdb",
  location: "us-east4",
  machineType: "e2-standard-4",
  minNodeCount: 3,
  maxNodeCount: 3,
  diskSizeGb: 100,
  releaseChannel: "REGULAR",
  workloadIdentity: true,
});

// ── Workload Identity — GCP Service Accounts ──────────────────────

// External DNS SA — bound to K8s SA "external-dns-sa" in "kube-system" namespace
export const externalDnsGsa = new GCPServiceAccount({
  metadata: {
    name: "gke-cockroachdb-dns",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  displayName: "GKE cockroachdb external-dns workload identity",
});

export const externalDnsWiBinding = new IAMPolicyMember({
  metadata: {
    name: "gke-cockroachdb-dns-wi",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  member: `serviceAccount:${config.projectId}.svc.id.goog[kube-system/external-dns-sa]`,
  role: "roles/iam.workloadIdentityUser",
  resourceRef: {
    apiVersion: "iam.cnrm.cloud.google.com/v1beta1",
    kind: "IAMServiceAccount",
    name: "gke-cockroachdb-dns",
  },
});

export const externalDnsDnsBinding = new IAMPolicyMember({
  metadata: {
    name: "gke-cockroachdb-dns-admin",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  member: `serviceAccount:gke-cockroachdb-dns@${config.projectId}.iam.gserviceaccount.com`,
  role: "roles/dns.admin",
  resourceRef: {
    apiVersion: "resourcemanager.cnrm.cloud.google.com/v1beta1",
    kind: "Project",
    external: `projects/${config.projectId}`,
  },
});
