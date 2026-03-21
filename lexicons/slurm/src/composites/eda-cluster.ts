/**
 * EDACluster composite — a complete Slurm cluster configuration for EDA workloads.
 *
 * Pre-wires the production-recommended settings for EDA/chip design clusters:
 * - select/cons_tres + CR_Core_Memory (TRES accounting for GPU + license tracking)
 * - proctrack/cgroup (reliable orphan cleanup for long-running sim jobs)
 * - slurmdbd accounting with enforcement (fairshare + QoS)
 * - Multifactor priority with strong fairshare weight
 * - EDA-specific partitions: synthesis, sim, gpu_eda
 * - License declarations for FlexLM/EDA tools
 *
 * Reference architecture: OpenHPC + SchedMD recommendations for EDA
 */

import { Cluster, Partition, Node, License, type ClusterProps, type PartitionProps, type NodeProps, type LicenseProps } from "../conf/resources";
import { GpuPartition, type GpuPartitionConfig } from "./gpu-partition";

export interface EDALicenseConfig {
  /** License token name as known to Slurm (e.g. "vcs_sim", "calibre_drc") */
  name: string;
  /** Total token count available cluster-wide */
  count: number;
  /** Optional description for documentation */
  description?: string;
}

export interface EDAClusterConfig {
  /** Cluster name */
  clusterName: string;
  /** Controller node hostname */
  controlMachine: string;
  /** slurmdbd host for accounting */
  accountingHost: string;
  /** StateSaveLocation — must be on shared storage */
  stateSaveLocation: string;
  /** CPU compute nodes (for synthesis/sim partitions) */
  cpuNodes: {
    pattern: string;
    cpusPerNode: number;
    memoryMb: number;
    count: number;
  };
  /** GPU nodes for RTL simulation acceleration / ML */
  gpuNodes?: GpuPartitionConfig;
  /** EDA tool licenses tracked by Slurm */
  licenses?: EDALicenseConfig[];
  /** JWT key path for slurmrestd access */
  jwtKeyPath?: string;
  /** Suspend/resume programs for cloud elasticity */
  suspend?: {
    program: string;
    resumeProgram: string;
    suspendTime: number;
    resumeTimeout: number;
  };
}

export interface EDAClusterResources {
  cluster: InstanceType<typeof Cluster>;
  cpuNodes: InstanceType<typeof Node>;
  synthesisPartition: InstanceType<typeof Partition>;
  simPartition: InstanceType<typeof Partition>;
  gpuNodes?: InstanceType<typeof Node>;
  gpuPartition?: InstanceType<typeof Partition>;
  licenses: Array<InstanceType<typeof License>>;
}

/**
 * Create a complete EDA cluster configuration.
 *
 * @example
 * ```typescript
 * export const {
 *   cluster, cpuNodes, synthesisPartition, simPartition,
 *   gpuNodes, gpuPartition, licenses,
 * } = EDACluster({
 *   clusterName: "hpc-eda",
 *   controlMachine: "head01.cluster.internal",
 *   accountingHost: "db.cluster.internal",
 *   stateSaveLocation: "/fsx/slurm/state",
 *   cpuNodes: { pattern: "cpu[001-032]", cpusPerNode: 96, memoryMb: 196608, count: 32 },
 *   gpuNodes: { partitionName: "gpu_eda", nodePattern: "gpu[001-004]", ... },
 *   licenses: [{ name: "vcs_sim", count: 200 }, { name: "calibre_drc", count: 30 }],
 * });
 * ```
 */
export function EDACluster(config: EDAClusterConfig): EDAClusterResources {
  const licenseTokens = config.licenses
    ? config.licenses.map((l) => `${l.name}:${l.count}`).join(",")
    : undefined;

  const clusterProps: ClusterProps = {
    ClusterName: config.clusterName,
    ControlMachine: config.controlMachine,

    // Auth
    AuthType: "auth/munge",
    ...(config.jwtKeyPath && {
      AuthAltTypes: "auth/jwt",
      AuthAltParameters: `jwt_key=${config.jwtKeyPath}`,
    }),

    // State
    StateSaveLocation: config.stateSaveLocation,

    // Scheduling — production EDA defaults
    SelectType: "select/cons_tres",
    SelectTypeParameters: "CR_Core_Memory",
    SlurmctldParameters: "enable_configless",
    ProctrackType: "proctrack/cgroup",
    PropagateResourceLimitsExcept: "MEMLOCK",
    SchedulerType: "sched/backfill",

    // Accounting
    AccountingStorageType: "accounting_storage/slurmdbd",
    AccountingStorageHost: config.accountingHost,
    AccountingStorageEnforce: "associations,limits,qos",

    // GPU GRES
    ...(config.gpuNodes && { GresTypes: "gpu" }),

    // EDA license tracking
    ...(licenseTokens && { Licenses: licenseTokens }),

    // Priority — multifactor with strong fairshare for multi-team EDA
    PriorityType: "priority/multifactor",
    PriorityWeightFairshare: 10000,
    PriorityWeightAge: 1000,
    PriorityWeightJobSize: 100,
    PriorityDecayHalfLife: "14-0",

    // Cloud elasticity (optional)
    ...(config.suspend && {
      SuspendProgram: config.suspend.program,
      ResumeProgram: config.suspend.resumeProgram,
      SuspendTime: config.suspend.suspendTime,
      ResumeTimeout: config.suspend.resumeTimeout,
    }),
  };

  const cpuNodeProps: NodeProps = {
    NodeName: config.cpuNodes.pattern,
    CPUs: config.cpuNodes.cpusPerNode,
    RealMemory: config.cpuNodes.memoryMb,
    State: "UNKNOWN",
  };

  const synthesisProps: PartitionProps = {
    PartitionName: "synthesis",
    Nodes: config.cpuNodes.pattern,
    Default: "YES",
    MaxTime: "2-00:00:00",  // 48h — typical synthesis run
    State: "UP",
    Priority: 50,
    DefMemPerCPU: Math.floor(config.cpuNodes.memoryMb / config.cpuNodes.cpusPerNode),
  };

  const simProps: PartitionProps = {
    PartitionName: "sim",
    Nodes: config.cpuNodes.pattern,
    Default: "NO",
    MaxTime: "7-00:00:00",  // 168h — long simulation runs
    State: "UP",
    Priority: 30,
    DefMemPerCPU: Math.floor(config.cpuNodes.memoryMb / config.cpuNodes.cpusPerNode),
  };

  const licenseResources = (config.licenses ?? []).map((l) => {
    const licProps: LicenseProps = {
      LicenseName: l.name,
      Count: l.count,
    };
    return new License(licProps as unknown as Record<string, unknown>);
  });

  const result: EDAClusterResources = {
    cluster: new Cluster(clusterProps as unknown as Record<string, unknown>),
    cpuNodes: new Node(cpuNodeProps as unknown as Record<string, unknown>),
    synthesisPartition: new Partition(synthesisProps as unknown as Record<string, unknown>),
    simPartition: new Partition(simProps as unknown as Record<string, unknown>),
    licenses: licenseResources,
  };

  if (config.gpuNodes) {
    const gpu = GpuPartition(config.gpuNodes);
    result.gpuNodes = gpu.nodes;
    result.gpuPartition = gpu.partition;
  }

  return result;
}
