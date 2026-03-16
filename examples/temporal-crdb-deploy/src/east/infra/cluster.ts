// GCP infrastructure: GKE cluster (us-east4) + Workload Identity IAM bindings.
// Uses n2-standard-2 (2 vCPU / 8 GiB) — e2-standard-2 is out of capacity
// in all us-east4 zones at time of writing.

import {
  GkeCluster,
  GCPServiceAccount,
  IAMPolicyMember,
} from "@intentius/chant-lexicon-gcp";
import { config } from "../config";

// ── GKE Cluster ────────────────────────────────────────────────────

export const { cluster, nodePool, defaultPool } = GkeCluster({
  name: config.clusterName,
  location: config.region,
  machineType: "n2-standard-2",
  network: "crdb-multi-region",
  subnetwork: "crdb-multi-region-east-nodes",
  minNodeCount: 1,
  maxNodeCount: 3,
  diskSizeGb: 100,
  releaseChannel: "REGULAR",
  workloadIdentity: true,
  privateNodes: true,
  masterCidr: "172.16.0.0/28",
});

// ── Workload Identity — ExternalDNS Service Account ────────────────

export const externalDnsGsa = new GCPServiceAccount({
  metadata: {
    name: "gke-crdb-east-dns",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  displayName: "GKE CockroachDB east external-dns workload identity",
});

export const externalDnsWiBinding = new IAMPolicyMember({
  metadata: {
    name: "gke-crdb-east-dns-wi",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  member: `serviceAccount:${config.projectId}.svc.id.goog[kube-system/external-dns-sa]`,
  role: "roles/iam.workloadIdentityUser",
  resourceRef: {
    apiVersion: "iam.cnrm.cloud.google.com/v1beta1",
    kind: "IAMServiceAccount",
    name: "gke-crdb-east-dns",
  },
});

export const externalDnsProjectBinding = new IAMPolicyMember({
  metadata: {
    name: "gke-crdb-east-dns-project",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  member: `serviceAccount:gke-crdb-east-dns@${config.projectId}.iam.gserviceaccount.com`,
  role: "roles/dns.admin",
  resourceRef: {
    apiVersion: "resourcemanager.cnrm.cloud.google.com/v1beta1",
    kind: "Project",
    external: `projects/${config.projectId}`,
  },
});
