/**
 * GKE Cluster + Node Pool with workload identity and autoscaling.
 */

import {
  GKECluster, NodePool,
  GCP, defaultAnnotations,
} from "@intentius/chant-lexicon-gcp";

export const annotations = defaultAnnotations({
  "cnrm.cloud.google.com/project-id": GCP.ProjectId,
});

export const cluster = new GKECluster({
  metadata: {
    name: "prod-cluster",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  location: "us-central1",
  initialNodeCount: 1,
  releaseChannel: { channel: "REGULAR" },
  workloadIdentityConfig: {
    workloadPool: "lucid-volt-257820.svc.id.goog",
  },
});

export const nodePool = new NodePool({
  metadata: {
    name: "prod-cluster-nodes",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  clusterRef: { name: "prod-cluster" },
  location: "us-central1",
  initialNodeCount: 2,
  autoscaling: {
    minNodeCount: 2,
    maxNodeCount: 20,
  },
  nodeConfig: {
    machineType: "e2-standard-4",
    diskSizeGb: 200,
    oauthScopes: ["https://www.googleapis.com/auth/cloud-platform"],
    workloadMetadataConfig: { mode: "GKE_METADATA" },
  },
  management: {
    autoRepair: true,
    autoUpgrade: true,
  },
});
