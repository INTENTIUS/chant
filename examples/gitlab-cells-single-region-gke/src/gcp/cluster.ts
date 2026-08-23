import { GkeCluster, NodePool } from "@intentius/chant-lexicon-gcp";
import { shared } from "../config";

export const { cluster, nodePool } = GkeCluster({
  name: shared.clusterName,
  projectId: shared.projectId,
  location: shared.region,
  machineType: shared.machineType,
  minNodeCount: shared.minNodeCount,
  maxNodeCount: shared.maxNodeCount,
  diskSizeGb: shared.nodeDiskSizeGb,
  releaseChannel: shared.releaseChannel,
  workloadIdentity: true,
  defaults: {
    cluster: {
      addonsConfig: { networkPolicyConfig: { disabled: false } },
      networkPolicy: { enabled: true, provider: "CALICO" },
    },
  },
});

// Optional dedicated runner node pool with taints (RUNNER_NODE_POOL_ENABLED=true).
export const runnerNodePool = shared.runnerNodePoolEnabled
  ? new NodePool({
      metadata: { name: `${shared.clusterName}-runners` },
      location: shared.region,
      clusterRef: { name: shared.clusterName },
      autoscaling: {
        minNodeCount: 0,
        maxNodeCount: shared.runnerNodePoolMaxCount,
      },
      nodeConfig: {
        machineType: shared.runnerNodePoolMachineType,
        diskSizeGb: 100,
        oauthScopes: ["https://www.googleapis.com/auth/cloud-platform"],
        workloadMetadataConfig: { mode: "GKE_METADATA" },
        taints: [
          { key: "gitlab.com/runner-only", value: "true", effect: "NO_SCHEDULE" },
        ],
      },
    })
  : null;
