/**
 * GKE Cluster + Node Pool + Workload Identity Service Account.
 */

import { GkeCluster, GCPServiceAccount, IAMPolicyMember, GCP } from "@intentius/chant-lexicon-gcp";
import { defaultAnnotations } from "@intentius/chant-lexicon-gcp";

export const annotations = defaultAnnotations({
  "cnrm.cloud.google.com/project-id": GCP.ProjectId,
});

export const { cluster, nodePool } = GkeCluster({
  name: "prod-cluster",
  location: "us-central1",
  machineType: "e2-standard-4",
  minNodeCount: 2,
  maxNodeCount: 20,
  diskSizeGb: 200,
  releaseChannel: "REGULAR",
});
