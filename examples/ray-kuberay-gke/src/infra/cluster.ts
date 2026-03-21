// GKE cluster + GPU node pool + Ray Workload Identity IAM bindings.
//
// Creates a regional GKE cluster (multi-zone, private nodes) with a separate
// GPU node pool that scales to zero. Ray head pods run in the default pool;
// GPU worker groups tolerate the nvidia.com/gpu taint on the GPU pool.
//
// NOTE: GKE REGULAR channel auto-installs the nvidia-device-plugin DaemonSet
// when a node pool has accelerators. Do NOT add it as a K8s manifest — it
// will conflict with the GKE-managed version.

import {
  GkeCluster,
  GCPServiceAccount,
  IAMPolicyMember,
  NodePool,
} from "@intentius/chant-lexicon-gcp";
import { config } from "../config";

// ── GKE Cluster ──────────────────────────────────────────────────────────

export const { cluster, nodePool } = GkeCluster({
  name: config.clusterName,
  location: config.region,
  machineType: "n2-standard-4",
  minNodeCount: 1,
  maxNodeCount: 5,
  diskSizeGb: 100,
  releaseChannel: "REGULAR",
  workloadIdentity: true,
  privateNodes: true,
  masterCidr: "172.16.0.0/28",
  network: config.vpcName,
  subnetwork: config.subnetName,
});

// ── GPU Node Pool ─────────────────────────────────────────────────────────
//
// Scales to zero when no GPU workers are needed.
// Tainted with nvidia.com/gpu=present:NoSchedule — only pods with the
// matching toleration (set by RayCluster workerGroups with gpuTolerations: true)
// will be scheduled here.

export const gpuNodePool = new NodePool({
  metadata: {
    name: `${config.clusterName}-gpu`,
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  spec: {
    clusterRef: { name: config.clusterName },
    location: config.region,
    initialNodeCount: 0,
    autoscaling: {
      enabled: true,
      minNodeCount: 0,
      maxNodeCount: 4,
      locationPolicy: "ANY",
    },
    nodeConfig: {
      machineType: "n1-standard-8",
      diskSizeGb: 200,
      diskType: "pd-ssd",
      accelerators: [
        { acceleratorCount: 1, acceleratorType: "nvidia-tesla-t4" },
      ],
      taints: [
        { key: "nvidia.com/gpu", value: "present", effect: "NO_SCHEDULE" },
      ],
      workloadMetadataConfig: { mode: "GKE_METADATA" },
      oauthScopes: ["https://www.googleapis.com/auth/cloud-platform"],
    },
    management: { autoRepair: true, autoUpgrade: true },
  },
});

// ── Ray Workload Identity ─────────────────────────────────────────────────
//
// GSA used by head pods for GCS access (spillover bucket).
// Bound to K8s SA ray-system/ray-head via Workload Identity.

export const rayGsa = new GCPServiceAccount({
  metadata: {
    name: "ray-workload",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  displayName: "Ray KubeRay head workload identity",
});

// WI binding: K8s SA ray-system/ray-head → GCP SA ray-workload
export const rayWiBinding = new IAMPolicyMember({
  metadata: {
    name: "ray-workload-wi",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  member: `serviceAccount:${config.projectId}.svc.id.goog[${config.namespace}/ray-head]`,
  role: "roles/iam.workloadIdentityUser",
  resourceRef: {
    apiVersion: "iam.cnrm.cloud.google.com/v1beta1",
    kind: "IAMServiceAccount",
    name: "ray-workload",
  },
});

// GCS object admin scoped to spillover bucket only
export const rayGcsBinding = new IAMPolicyMember({
  metadata: {
    name: "ray-workload-gcs",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  member: `serviceAccount:ray-workload@${config.projectId}.iam.gserviceaccount.com`,
  role: "roles/storage.objectAdmin",
  resourceRef: {
    apiVersion: "storage.cnrm.cloud.google.com/v1beta1",
    kind: "StorageBucket",
    name: config.spilloverBucketName,
  },
});
