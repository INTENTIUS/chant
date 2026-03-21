/**
 * GpuPartition composite — a Partition + matching Node for GPU workloads.
 *
 * Wires together the Slurm::Conf::Partition and Slurm::Conf::Node resources
 * needed for a GPU partition with GRES, Feature flags, and appropriate
 * memory/time defaults for EDA/ML workloads.
 */

import { Partition, Node, type PartitionProps, type NodeProps } from "../conf/resources";

export interface GpuPartitionConfig {
  /** Partition name (e.g. "gpu_eda", "train"). */
  partitionName: string;
  /** Node name expression (e.g. "gpu[001-004]"). */
  nodePattern: string;
  /** GPU type and count per node (e.g. "a100:8", "h100:4"). */
  gpuTypeCount: string;
  /** Number of CPUs per node. */
  cpusPerNode: number;
  /** Memory per node in MB. */
  memoryMb: number;
  /**
   * Maximum wall time for jobs.
   * @default "1-00:00:00" (24 hours)
   */
  maxTime?: string;
  /**
   * Node feature flags (e.g. "efa,a100_80g").
   * Automatically includes the GPU type as a feature.
   */
  features?: string;
  /**
   * Whether this is the default partition.
   * @default false
   */
  default?: boolean;
  /**
   * Scheduling priority (higher = preferred).
   * @default 50
   */
  priority?: number;
}

export interface GpuPartitionResources {
  nodes: InstanceType<typeof Node>;
  partition: InstanceType<typeof Partition>;
}

/**
 * Create a GPU partition composite.
 *
 * Returns Node and Partition resources ready to export from your chant project.
 * Both are wired to share the same node pattern, so the partition correctly
 * references the declared nodes.
 *
 * @example
 * ```typescript
 * export const { nodes: gpuNodes, partition: gpuPartition } = GpuPartition({
 *   partitionName: "gpu_eda",
 *   nodePattern: "gpu[001-004]",
 *   gpuTypeCount: "a100:8",
 *   cpusPerNode: 96,
 *   memoryMb: 1_048_576,  // 1 TB
 *   features: "efa",
 *   maxTime: "1-00:00:00",
 * });
 * ```
 */
export function GpuPartition(config: GpuPartitionConfig): GpuPartitionResources {
  const gpuType = config.gpuTypeCount.split(":")[0] ?? "gpu";
  const features = [gpuType, ...(config.features ? config.features.split(",") : [])]
    .filter(Boolean)
    .join(",");

  const nodeProps: NodeProps = {
    NodeName: config.nodePattern,
    CPUs: config.cpusPerNode,
    RealMemory: config.memoryMb,
    Gres: `gpu:${config.gpuTypeCount}`,
    Feature: features,
    State: "UNKNOWN",
  };

  const partitionProps: PartitionProps = {
    PartitionName: config.partitionName,
    Nodes: config.nodePattern,
    Default: config.default ? "YES" : "NO",
    MaxTime: config.maxTime ?? "1-00:00:00",
    State: "UP",
    Priority: config.priority ?? 50,
    OverSubscribe: "NO",
  };

  return {
    nodes: new Node(nodeProps as unknown as Record<string, unknown>),
    partition: new Partition(partitionProps as unknown as Record<string, unknown>),
  };
}
