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
  /** GCP project ID for workload identity pool. Falls back to GCP_PROJECT_ID env var. */
  projectId?: string;
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
  /** Boot disk type for nodes (default: "pd-standard"). */
  diskType?: string;
  /** VPC network name (if omitted, uses default network). */
  network?: string;
  /** Subnetwork name for the cluster nodes. */
  subnetwork?: string;
  /**
   * Enable private nodes — nodes have only internal IPs, no external IPs.
   * Requires Cloud NAT for egress. Keeps master endpoint public so kubectl works from outside.
   * Requires masterCidr when enabled.
   */
  privateNodes?: boolean;
  /**
   * CIDR block for the master's private endpoint (e.g. "172.16.0.0/28").
   * Must be /28, unique per cluster, and not overlap with node/pod CIDRs.
   * Required when privateNodes is true.
   */
  masterCidr?: string;
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
    defaultPool?: Partial<ConstructorParameters<typeof NodePool>[0]>;
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
    projectId: rawProjectId,
    location,
    initialNodeCount = 1,
    machineType = "e2-medium",
    minNodeCount = 1,
    maxNodeCount = 5,
    workloadIdentity = true,
    diskSizeGb = 100,
    diskType = "pd-standard",
    network: networkName,
    subnetwork: subnetworkName,
    privateNodes = false,
    masterCidr,
    releaseChannel = "REGULAR",
    labels: extraLabels = {},
    namespace,
    defaults: defs,
  } = props;

  const projectId = rawProjectId ?? process.env.GCP_PROJECT_ID ?? "PROJECT_ID";

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/managed-by": "chant",
    ...extraLabels,
  };

  const clusterSpec: Record<string, unknown> = {
    // GKE API requires initialNodeCount > 0 even when using a separate
    // ContainerNodePool. Force pd-standard so the default pool doesn't
    // consume SSD_TOTAL_GB quota (pd-balanced counts as SSD).
    initialNodeCount: 1,
    nodeConfig: {
      diskType: "pd-standard",
      diskSizeGb: 50,
    },
    releaseChannel: { channel: releaseChannel },
    ...(location && { location }),
    ...(networkName && { networkRef: { name: networkName } }),
    ...(subnetworkName && { subnetworkRef: { name: subnetworkName } }),
    ...(privateNodes && {
      privateClusterConfig: {
        enablePrivateNodes: true,
        // Keep master endpoint public so kubectl works from outside the VPC.
        enablePrivateEndpoint: false,
        ...(masterCidr && { masterIpv4CidrBlock: masterCidr }),
      },
    }),
  };

  if (workloadIdentity) {
    clusterSpec.workloadIdentityConfig = {
      workloadPool: `${projectId}.svc.id.goog`,
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
      diskType,
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

  // Adopt and scale the GKE-required default pool to 0.
  // resourceID maps this K8s resource to the GCP pool named "default-pool".
  // Config Connector retries until the workload pool has nodes, at which
  // point GKE accepts the resize-to-zero.
  const defaultPool = new NodePool(mergeDefaults({
    metadata: {
      name: `${name}-default-pool`,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "default-pool" },
    },
    resourceID: "default-pool",
    clusterRef: { name },
    nodeCount: 0,
    ...(location && { location }),
  } as Record<string, unknown>, defs?.defaultPool));

  return { cluster, nodePool, defaultPool };
}, "GkeCluster");
