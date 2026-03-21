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

import { Cluster, Partition, Node, License, GresNode, CgroupConf, type ClusterProps, type PartitionProps, type NodeProps, type LicenseProps } from "../conf/resources";
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
    socketsPerNode?: number;
    coresPerSocket?: number;
    threadsPerCore?: number;
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
    excludeNodes?: string;   // nodes excluded from power-down (e.g. "head01")
    excludeParts?: string;   // partitions excluded from power-down
    resumeRate?: number;     // max nodes/min to resume (default 300)
    suspendRate?: number;    // max nodes/min to suspend (default 60)
  };
  /** cgroup.conf generation — required when ProctrackType=proctrack/cgroup */
  cgroupConf?: {
    plugin?: "cgroup/v2" | "autodetect";
    constrainRAMSpace?: boolean;
    constrainCores?: boolean;
    constrainDevices?: boolean;
    allowedRAMSpace?: number;
    minRAMSpace?: number;
  };
  /** Energy accounting plugin */
  acctGatherEnergy?: {
    type: "rapl" | "ipmi" | "gpu" | "none";
    nodeFreq?: number;
  };
  /** Preemption plugin */
  preemptType?: "preempt/none" | "preempt/partition_prio" | "preempt/qos" | string;
  /** LBNL NHC or similar node health check program */
  healthCheck?: {
    program: string;
    interval?: number;
    nodeState?: "ALLOC" | "ANY" | "CYCLE" | "IDLE" | "MIXED";
  };
  /** MPI default plugin — "pmix" recommended for OpenMPI + NCCL workloads */
  mpiDefault?: "none" | "pmi2" | "pmix" | string;
  /** Task plugin for affinity/cgroup binding */
  taskPlugin?: "task/affinity" | "task/cgroup" | string;
  /**
   * ReturnToService policy for CLOUD nodes.
   * Defaults to 1 when suspend is configured (nodes must re-register after spot resume).
   */
  returnToService?: 0 | 1 | 2;
  /** Seconds before a non-responding slurmd marks a node DOWN. Lower = faster spot detection. */
  slurmdTimeout?: number;
}

export interface EDAClusterResources {
  cluster: InstanceType<typeof Cluster>;
  cpuNodes: InstanceType<typeof Node>;
  synthesisPartition: InstanceType<typeof Partition>;
  simPartition: InstanceType<typeof Partition>;
  gpuNodes?: InstanceType<typeof Node>;
  gpuPartition?: InstanceType<typeof Partition>;
  gresNode?: InstanceType<typeof GresNode>;
  licenses: Array<InstanceType<typeof License>>;
  cgroupConf?: InstanceType<typeof CgroupConf>;
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
      ...(config.suspend.excludeNodes !== undefined && { SuspendExcNodes: config.suspend.excludeNodes }),
      ...(config.suspend.excludeParts !== undefined && { SuspendExcParts: config.suspend.excludeParts }),
      ...(config.suspend.resumeRate !== undefined && { ResumeRate: config.suspend.resumeRate }),
      ...(config.suspend.suspendRate !== undefined && { SuspendRate: config.suspend.suspendRate }),
    }),

    // ReturnToService: default to 1 when suspend is configured (CLOUD nodes must re-register)
    ReturnToService: config.returnToService ?? (config.suspend ? 1 : undefined),

    // Node health checking
    ...(config.healthCheck && {
      HealthCheckProgram: config.healthCheck.program,
      HealthCheckInterval: config.healthCheck.interval,
      HealthCheckNodeState: config.healthCheck.nodeState,
    }),

    // MPI and task affinity
    ...(config.mpiDefault !== undefined && { MpiDefault: config.mpiDefault }),
    ...(config.taskPlugin !== undefined && { TaskPlugin: config.taskPlugin }),

    // Slurmd timeout for faster DOWN detection on spot instances
    ...(config.slurmdTimeout !== undefined && { SlurmdTimeout: config.slurmdTimeout }),

    // Energy accounting
    ...(config.acctGatherEnergy && {
      AcctGatherEnergyType: `acct_gather_energy/${config.acctGatherEnergy.type}`,
      ...(config.acctGatherEnergy.nodeFreq !== undefined && { AcctGatherNodeFreq: config.acctGatherEnergy.nodeFreq }),
    }),

    // Preemption
    ...(config.preemptType !== undefined && { PreemptType: config.preemptType }),
  };

  const cpuNodeProps: NodeProps = {
    NodeName: config.cpuNodes.pattern,
    CPUs: config.cpuNodes.cpusPerNode,
    RealMemory: config.cpuNodes.memoryMb,
    State: "UNKNOWN",
    ...(config.cpuNodes.socketsPerNode !== undefined && { Sockets: config.cpuNodes.socketsPerNode }),
    ...(config.cpuNodes.coresPerSocket !== undefined && { CoresPerSocket: config.cpuNodes.coresPerSocket }),
    ...(config.cpuNodes.threadsPerCore !== undefined && { ThreadsPerCore: config.cpuNodes.threadsPerCore }),
  };

  const synthesisProps: PartitionProps = {
    PartitionName: "synthesis",
    Nodes: config.cpuNodes.pattern,
    Default: "YES",
    MaxTime: "2-00:00:00",  // 48h — typical synthesis run
    State: "UP",
    Priority: 50,
    DefMemPerCPU: Math.floor(config.cpuNodes.memoryMb / config.cpuNodes.cpusPerNode),
    ...(config.suspend && { PowerDownOnIdle: "YES" }),
  };

  const simProps: PartitionProps = {
    PartitionName: "sim",
    Nodes: config.cpuNodes.pattern,
    Default: "NO",
    MaxTime: "7-00:00:00",  // 168h — long simulation runs
    State: "UP",
    Priority: 30,
    DefMemPerCPU: Math.floor(config.cpuNodes.memoryMb / config.cpuNodes.cpusPerNode),
    ...(config.suspend && { PowerDownOnIdle: "YES" }),
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
    if (gpu.gresNode) result.gresNode = gpu.gresNode;
  }

  if (config.cgroupConf !== undefined) {
    const hasGpuNodes = config.gpuNodes !== undefined;
    result.cgroupConf = new CgroupConf({
      CgroupPlugin: config.cgroupConf.plugin ?? "cgroup/v2",
      ConstrainRAMSpace: config.cgroupConf.constrainRAMSpace ?? true,
      ConstrainCores: config.cgroupConf.constrainCores ?? true,
      ...(config.cgroupConf.constrainDevices !== undefined
        ? { ConstrainDevices: config.cgroupConf.constrainDevices }
        : hasGpuNodes ? { ConstrainDevices: true } : {}),
      AllowedRAMSpace: config.cgroupConf.allowedRAMSpace ?? 95,
      MinRAMSpace: config.cgroupConf.minRAMSpace ?? 30,
    } as unknown as Record<string, unknown>);
  }

  return result;
}
