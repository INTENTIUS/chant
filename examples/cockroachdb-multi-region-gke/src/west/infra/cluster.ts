// GCP infrastructure: GKE cluster (us-west1) + Workload Identity IAM bindings.
// Sized for CockroachDB: 3x e2-standard-2 (2 vCPU / 8 GiB) worker nodes.

import {
  GkeCluster,
  GCPServiceAccount,
  IAMPolicyMember,
} from "@intentius/chant-lexicon-gcp";
import { config } from "../config";

// ── GKE Cluster ────────────────────────────────────────────────────

export const { cluster, nodePool } = GkeCluster({
  name: config.clusterName,
  location: config.region,
  machineType: "e2-standard-2",
  network: "crdb-multi-region",
  subnetwork: "crdb-multi-region-west-nodes",
  minNodeCount: 1,
  maxNodeCount: 1,
  diskSizeGb: 100,
  releaseChannel: "REGULAR",
  workloadIdentity: true,
});

// ── Workload Identity — ExternalDNS Service Account ────────────────

export const externalDnsGsa = new GCPServiceAccount({
  metadata: {
    name: "gke-crdb-west-dns",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  displayName: "GKE CockroachDB west external-dns workload identity",
});

export const externalDnsWiBinding = new IAMPolicyMember({
  metadata: {
    name: "gke-crdb-west-dns-wi",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  member: `serviceAccount:${config.projectId}.svc.id.goog[kube-system/external-dns-sa]`,
  role: "roles/iam.workloadIdentityUser",
  resourceRef: {
    apiVersion: "iam.cnrm.cloud.google.com/v1beta1",
    kind: "IAMServiceAccount",
    name: "gke-crdb-west-dns",
  },
});

export const externalDnsProjectBinding = new IAMPolicyMember({
  metadata: {
    name: "gke-crdb-west-dns-project",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  member: `serviceAccount:gke-crdb-west-dns@${config.projectId}.iam.gserviceaccount.com`,
  role: "roles/dns.admin",
  resourceRef: {
    apiVersion: "resourcemanager.cnrm.cloud.google.com/v1beta1",
    kind: "Project",
    external: `projects/${config.projectId}`,
  },
});
