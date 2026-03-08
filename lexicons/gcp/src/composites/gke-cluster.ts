/**
 * GkeCluster composite — ContainerCluster + ContainerNodePool.
 *
 * Creates a GKE cluster with a default node pool configured for
 * workload identity and autoscaling.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import { GKECluster, NodePool } from "../generated";

export interface GkeClusterProps {
  /** Cluster name. */
  name: string;
  /** GCP region for regional cluster (default: uses GCP.Region). */
  location?: string;
  /** Initial node count per zone (default: 1). */
  initialNodeCount?: number;
  /** Machine type for nodes (default: "e2-medium"). */
  machineType?: string;
  /** Minimum nodes for autoscaling (default: 1). */
  minNodeCount?: number;
  /** Maximum nodes for autoscaling (default: 5). */
  maxNodeCount?: number;
  /** Enable workload identity (default: true). */
  workloadIdentity?: boolean;
  /** Disk size in GB for nodes (default: 100). */
  diskSizeGb?: number;
  /** GKE release channel (default: "REGULAR"). */
  releaseChannel?: "RAPID" | "REGULAR" | "STABLE";
  /** Additional labels. */
  labels?: Record<string, string>;
  /** Namespace for all resources. */
  namespace?: string;
  /** Per-member defaults for customizing individual resources. */
  defaults?: {
    cluster?: Partial<ConstructorParameters<typeof GKECluster>[0]>;
    nodePool?: Partial<ConstructorParameters<typeof NodePool>[0]>;
  };
}

/**
 * Create a GkeCluster composite — returns declarable instances for
 * a ContainerCluster and ContainerNodePool.
 *
 * @example
 * ```ts
 * import { GkeCluster } from "@intentius/chant-lexicon-gcp";
 *
 * const { cluster, nodePool } = GkeCluster({
 *   name: "my-cluster",
 *   location: "us-central1",
 *   maxNodeCount: 10,
 * });
 * ```
 */
export const GkeCluster = Composite<GkeClusterProps>((props) => {
  const {
    name,
    location,
    initialNodeCount = 1,
    machineType = "e2-medium",
    minNodeCount = 1,
    maxNodeCount = 5,
    workloadIdentity = true,
    diskSizeGb = 100,
    releaseChannel = "REGULAR",
    labels: extraLabels = {},
    namespace,
    defaults: defs,
  } = props;

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/managed-by": "chant",
    ...extraLabels,
  };

  const clusterSpec: Record<string, unknown> = {
    initialNodeCount: 1, // Minimal default pool, real nodes in separate pool
    releaseChannel: { channel: releaseChannel },
    ...(location && { location }),
  };

  if (workloadIdentity) {
    clusterSpec.workloadIdentityConfig = {
      workloadPool: `PROJECT_ID.svc.id.goog`,
    };
  }

  const cluster = new GKECluster(mergeDefaults({
    metadata: {
      name,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "cluster" },
    },
    ...clusterSpec,
  } as Record<string, unknown>, defs?.cluster));

  const nodePoolName = `${name}-nodes`;
  const nodePool = new NodePool(mergeDefaults({
    metadata: {
      name: nodePoolName,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "node-pool" },
    },
    clusterRef: { name },
    initialNodeCount,
    autoscaling: {
      minNodeCount,
      maxNodeCount,
    },
    nodeConfig: {
      machineType,
      diskSizeGb,
      oauthScopes: ["https://www.googleapis.com/auth/cloud-platform"],
      ...(workloadIdentity && {
        workloadMetadataConfig: { mode: "GKE_METADATA" },
      }),
    },
    management: {
      autoRepair: true,
      autoUpgrade: true,
    },
    ...(location && { location }),
  } as Record<string, unknown>, defs?.nodePool));

  return { cluster, nodePool };
}, "GkeCluster");
