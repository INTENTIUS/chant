/**
 * GpuNodePool composite — ContainerNodePool with GPU accelerators.
 *
 * Promoted from the hand-wired `gpuNodePool` in the ray-kuberay-gke example
 * (examples/ray-kuberay-gke/src/infra/cluster.ts). Attaches to an existing
 * GKE cluster (e.g. one created by `GkeCluster`) and adds a separate,
 * scale-to-zero pool for GPU-tainted workloads.
 *
 * NOTE: GKE auto-installs the nvidia-device-plugin DaemonSet when a node
 * pool has accelerators. Do NOT emit it as a K8s manifest — it will
 * conflict with the GKE-managed version.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import { NodePool } from "../generated";

export interface GpuNodePoolTaint {
  key: string;
  value: string;
  effect: string;
}

export interface GpuNodePoolProps {
  /** Node pool name. */
  name: string;
  /** Reference to the GKE cluster this pool attaches to, e.g. `{ name: "my-cluster" }`. */
  clusterRef: Record<string, unknown>;
  /** GCP region or zone of the cluster. */
  location: string;
  /** Machine type for GPU nodes (default: "n1-standard-8"). */
  machineType?: string;
  /** Accelerator type, e.g. "nvidia-tesla-t4", "nvidia-l4", "nvidia-tesla-a100" (default: "nvidia-tesla-t4"). */
  acceleratorType?: string;
  /** Number of accelerators per node (default: 1). */
  acceleratorCount?: number;
  /** Minimum nodes for autoscaling — 0 enables scale-to-zero (default: 0). */
  minNodeCount?: number;
  /** Maximum nodes for autoscaling (default: 4). */
  maxNodeCount?: number;
  /** Boot disk size in GB (default: 200). */
  diskSizeGb?: number;
  /** Boot disk type (default: "pd-ssd"). */
  diskType?: string;
  /**
   * Node taints — only pods with a matching toleration are scheduled here.
   * Default: `nvidia.com/gpu=present:NO_SCHEDULE`. Pass an empty array to omit tainting.
   */
  taint?: GpuNodePoolTaint[];
  /** Enable GKE metadata server workload identity mode on nodes (default: true). */
  workloadMetadata?: boolean;
  /**
   * GPU time-sharing configuration, e.g.
   * `{ maxSharedClientsPerGpu: 2, gpuSharingStrategy: "TIME_SHARING" }`.
   */
  gpuSharingConfig?: Record<string, unknown>;
  /** Multi-instance GPU (MIG) partition size, e.g. "1g.5gb". */
  gpuPartitionSize?: string;
  /** Additional labels. */
  labels?: Record<string, string>;
  /** Namespace for the node pool resource. */
  namespace?: string;
  /** Per-member defaults for customizing the underlying resource. */
  defaults?: {
    nodePool?: Partial<ConstructorParameters<typeof NodePool>[0]>;
  };
}

const DEFAULT_TAINT: GpuNodePoolTaint[] = [
  { key: "nvidia.com/gpu", value: "present", effect: "NO_SCHEDULE" },
];

/**
 * Create a GpuNodePool composite — a scale-to-zero ContainerNodePool with
 * GPU accelerators, tainted so only pods with a matching toleration land there.
 *
 * @example
 * ```ts
 * import { GpuNodePool } from "@intentius/chant-lexicon-gcp";
 *
 * const { nodePool } = GpuNodePool({
 *   name: "ray-gke-gpu",
 *   clusterRef: { name: "ray-gke" },
 *   location: "us-central1",
 *   acceleratorType: "nvidia-tesla-t4",
 *   maxNodeCount: 4,
 * });
 * ```
 */
export const GpuNodePool = Composite((props: GpuNodePoolProps) => {
  const {
    name,
    clusterRef,
    location,
    machineType = "n1-standard-8",
    acceleratorType = "nvidia-tesla-t4",
    acceleratorCount = 1,
    minNodeCount = 0,
    maxNodeCount = 4,
    diskSizeGb = 200,
    diskType = "pd-ssd",
    taint = DEFAULT_TAINT,
    workloadMetadata = true,
    gpuSharingConfig,
    gpuPartitionSize,
    labels: extraLabels = {},
    namespace,
    defaults: defs,
  } = props;

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/managed-by": "chant",
    ...extraLabels,
  };

  const guestAccelerator: Record<string, unknown> = {
    count: acceleratorCount,
    type: acceleratorType,
    ...(gpuSharingConfig && { gpuSharingConfig }),
    ...(gpuPartitionSize && { gpuPartitionSize }),
  };

  const nodePool = new NodePool(mergeDefaults({
    metadata: {
      name,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "gpu-node-pool" },
    },
    clusterRef,
    location,
    initialNodeCount: 0,
    autoscaling: {
      minNodeCount,
      maxNodeCount,
      locationPolicy: "ANY",
    },
    nodeConfig: {
      machineType,
      diskSizeGb,
      diskType,
      guestAccelerator: [guestAccelerator],
      ...(taint.length > 0 && { taint }),
      ...(workloadMetadata && { workloadMetadataConfig: { mode: "GKE_METADATA" } }),
      oauthScopes: ["https://www.googleapis.com/auth/cloud-platform"],
    },
    management: { autoRepair: true, autoUpgrade: true },
  } as Record<string, unknown>, defs?.nodePool));

  return { nodePool };
}, "GpuNodePool");
