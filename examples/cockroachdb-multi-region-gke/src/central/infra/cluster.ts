// GCP infrastructure: GKE cluster (us-central1) + Workload Identity IAM bindings.
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
  subnetwork: "crdb-multi-region-central-nodes",
  minNodeCount: 1,
  maxNodeCount: 1,
  diskSizeGb: 100,
  releaseChannel: "REGULAR",
  workloadIdentity: true,
  privateNodes: true,
  masterCidr: "172.16.1.0/28",
});

// ── Workload Identity — ExternalDNS Service Account ────────────────

export const externalDnsGsa = new GCPServiceAccount({
  metadata: {
    name: "gke-crdb-central-dns",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  displayName: "GKE CockroachDB central external-dns workload identity",
});

export const externalDnsWiBinding = new IAMPolicyMember({
  metadata: {
    name: "gke-crdb-central-dns-wi",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  member: `serviceAccount:${config.projectId}.svc.id.goog[kube-system/external-dns-sa]`,
  role: "roles/iam.workloadIdentityUser",
  resourceRef: {
    apiVersion: "iam.cnrm.cloud.google.com/v1beta1",
    kind: "IAMServiceAccount",
    name: "gke-crdb-central-dns",
  },
});

export const externalDnsProjectBinding = new IAMPolicyMember({
  metadata: {
    name: "gke-crdb-central-dns-project",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  member: `serviceAccount:gke-crdb-central-dns@${config.projectId}.iam.gserviceaccount.com`,
  role: "roles/dns.admin",
  resourceRef: {
    apiVersion: "resourcemanager.cnrm.cloud.google.com/v1beta1",
    kind: "Project",
    external: `projects/${config.projectId}`,
  },
});
