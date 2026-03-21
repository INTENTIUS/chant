/**
 * Slurm configuration resources — hand-written Declarable constructors.
 *
 * These model the stanzas in slurm.conf that the serializer emits.
 * They use createResource from core (same mechanism as generated resources)
 * but are maintained by hand rather than generated from a schema.
 *
 * Reference: https://slurm.schedmd.com/slurm.conf.html (Slurm 23.11)
 */

import { createResource } from "@intentius/chant/runtime";

// ── Cluster ─────────────────────────────────────────────────────────
// Maps to the global configuration stanza in slurm.conf.
// All fields except ClusterName are optional — only set fields are emitted.

export const Cluster = createResource("Slurm::Conf::Cluster", "slurm", {});

export interface ClusterProps {
  ClusterName: string;
  ControlMachine: string;
  AuthType?: "auth/munge" | "auth/none";
  AuthAltTypes?: string;          // "auth/jwt"
  AuthAltParameters?: string;     // "jwt_key=/etc/slurm/jwt_hs256.key"
  StateSaveLocation?: string;     // "/var/spool/slurm"
  SlurmctldPort?: number;
  SlurmdPort?: number;
  SlurmctldLogFile?: string;
  SlurmdLogFile?: string;
  SlurmctldPidFile?: string;
  SlurmdPidFile?: string;
  SelectType?: "select/cons_tres" | "select/cons_res" | "select/linear";
  SelectTypeParameters?: string;  // "CR_Core_Memory", "CR_CPU_Memory", etc.
  SlurmctldParameters?: string;   // "enable_configless,..."
  ProctrackType?: "proctrack/cgroup" | "proctrack/linuxproc" | string;
  PropagateResourceLimitsExcept?: string; // "MEMLOCK"
  AccountingStorageType?: "accounting_storage/slurmdbd" | "accounting_storage/none" | string;
  AccountingStorageHost?: string;
  AccountingStorageEnforce?: string; // "associations,limits,qos"
  GresTypes?: string;             // "gpu" etc.
  Licenses?: string;              // "vcs_sim:200,calibre_drc:30"
  PriorityType?: "priority/multifactor" | "priority/basic" | string;
  PriorityWeightFairshare?: number;
  PriorityWeightAge?: number;
  PriorityWeightJobSize?: number;
  PriorityWeightPartition?: number;
  PriorityDecayHalfLife?: string; // "14-0" (days-hours)
  SchedulerType?: "sched/backfill" | string;
  JobAcctGatherType?: string;
  JobAcctGatherFrequency?: number;
  CompleteWait?: number;
  KillWait?: number;
  SuspendProgram?: string;        // script path for node suspend
  ResumeProgram?: string;         // script path for node resume
  SuspendTime?: number;           // seconds before idle node suspended
  ResumeTimeout?: number;         // max seconds for node to resume
  SuspendExcNodes?: string;       // node list excluded from power-down (e.g. "head01")
  SuspendExcParts?: string;       // partition list excluded from power-down
  ResumeRate?: number;            // max nodes/min to resume (default 300); lower = gentler ASG scaling
  SuspendRate?: number;           // max nodes/min to suspend (default 60)
  HealthCheckProgram?: string;    // path to NHC script (e.g. "/usr/sbin/nhc")
  HealthCheckInterval?: number;   // seconds between health checks (Slurm default: 30)
  HealthCheckNodeState?: "ALLOC" | "ANY" | "CYCLE" | "IDLE" | "MIXED";
  MpiDefault?: "none" | "pmi2" | "pmix" | "pmix_v2" | "pmix_v3" | string;
  TaskPlugin?: "task/affinity" | "task/cgroup" | string;
  ReturnToService?: 0 | 1 | 2;   // 1 = return CLOUD node when it re-registers (essential for spot)
  SlurmdTimeout?: number;         // seconds before node marked DOWN (lower = faster spot detection)
  InactiveLimit?: number;         // seconds a job can be inactive before being killed
  TopologyPlugin?: "topology/tree" | "topology/block" | "topology/flat" | string;
  AcctGatherEnergyType?: "acct_gather_energy/rapl" | "acct_gather_energy/ipmi" |
                          "acct_gather_energy/gpu" | "acct_gather_energy/none" | string;
  AcctGatherNodeFreq?: number;    // seconds; MUST be <300 for RAPL (counter overflow)
  AcctGatherInterconnectType?: "acct_gather_interconnect/ofed" |
                                "acct_gather_interconnect/sysfs" |
                                "acct_gather_interconnect/none" | string;
  PreemptType?: "preempt/none" | "preempt/partition_prio" | "preempt/qos" | string;
}

// ── Partition ────────────────────────────────────────────────────────
// Maps to PartitionName stanzas in slurm.conf.

export const Partition = createResource("Slurm::Conf::Partition", "slurm", {});

export interface PartitionProps {
  PartitionName: string;
  Nodes?: string;               // node list expression
  Default?: "YES" | "NO";
  MaxTime?: string | "UNLIMITED"; // "UNLIMITED" or "D-HH:MM:SS"
  State?: "UP" | "DOWN" | "INACTIVE" | "DRAIN";
  OverSubscribe?: "NO" | "YES" | "EXCLUSIVE" | "FORCE";
  Priority?: number;
  QOS?: string;
  DefMemPerCPU?: number;        // MB per CPU
  DefMemPerNode?: number;       // MB per node (conflicts with DefMemPerCPU)
  MaxMemPerCPU?: number;
  MaxMemPerNode?: number;
  AllowGroups?: string;
  AllowAccounts?: string;
  DenyAccounts?: string;
  PreemptMode?: "OFF" | "CANCEL" | "CHECKPOINT" | "GANG" | "REQUEUE" | "SUSPEND";
  TRESBillingWeights?: string;  // "CPU=1.0,Mem=0.25G,GRES/gpu=2.0"
  LLN?: "YES" | "NO";          // Least Loaded Node scheduling
  PowerDownOnIdle?: "YES" | "NO"; // suspend node as soon as its last job finishes
  SuspendTime?: number;         // per-partition SuspendTime override in seconds
}

// ── Node ─────────────────────────────────────────────────────────────
// Maps to NodeName stanzas in slurm.conf.

export const Node = createResource("Slurm::Conf::Node", "slurm", {});

export interface NodeProps {
  NodeName: string;             // node name expression (e.g. "node[001-016]")
  NodeAddr?: string;            // IP address or hostname
  CPUs?: number;
  RealMemory?: number;          // MB
  Sockets?: number;
  CoresPerSocket?: number;
  ThreadsPerCore?: number;
  Gres?: string;                // "gpu:a100:8,nvme:3200"
  Feature?: string;             // comma-separated: "efa,h100"
  State?: "UNKNOWN" | "DOWN" | "FUTURE" | "CLOUD" | "DRAIN";
  Weight?: number;              // scheduling weight (lower → preferred)
  TmpDisk?: number;             // local tmp disk in MB
}

// ── GresNode ─────────────────────────────────────────────────────
// Maps to entries in gres.conf (not slurm.conf).
// The serializer routes GresNode entities to a separate gres.conf file.

export const GresNode = createResource("Slurm::Conf::GresNode", "slurm", {});

export interface GresNodeProps {
  NodeName: string;              // matches Node stanza NodeName
  Name: "gpu" | "nic" | string; // resource family
  Type?: string;                 // "a100", "h100", "v100"
  File?: string;                 // "/dev/nvidia[0-7]"
  Count?: number;                // explicit count (when not using AutoDetect)
  AutoDetect?: "nvml" | "rsmi" | "oneapi" | "nrt" | "off"; // nvml = NVIDIA, rsmi = AMD, oneapi = Intel, nrt = AWS Neuron
  Cores?: string;                // CPU cores NUMA-local to this GPU, e.g. "0-11" or "0-47"
  Links?: string;                // NVLink topology matrix "0,0,-1,0,0,-1,-1,-1"
}

// ── License ──────────────────────────────────────────────────────────
// Represents a license resource managed by Slurm via sacctmgr.
// In slurm.conf this maps to the Licenses= global key.
// When used as a standalone resource, the serializer emits a Licenses= line.

export const License = createResource("Slurm::Conf::License", "slurm", {});

export interface LicenseProps {
  LicenseName: string;          // e.g. "vcs_sim"
  Count: number;                // total token count
  Server?: string;              // license server (optional; for info only)
}

// ── CgroupConf ───────────────────────────────────────────────────────
// Maps to /etc/slurm/cgroup.conf — required when ProctrackType=proctrack/cgroup.
// Without cgroup.conf, ConstrainRAMSpace defaults to false and runaway jobs can
// consume all node memory.

export const CgroupConf = createResource("Slurm::Conf::CgroupConf", "slurm", {});

export interface CgroupConfProps {
  CgroupPlugin?: "cgroup/v2" | "cgroup/v1" | "autodetect" | string;
  ConstrainRAMSpace?: boolean;   // hard memory limits (default false — must set true)
  ConstrainCores?: boolean;      // cpuset isolation
  ConstrainDevices?: boolean;    // GPU device isolation (requires gres.conf File=)
  ConstrainSwapSpace?: boolean;
  AllowedRAMSpace?: number;      // % of allocation (100 = exact, 95 = recommended)
  AllowedSwapSpace?: number;     // %
  MaxRAMPercent?: number;        // cap for unspecified job memory requests
  MinRAMSpace?: number;          // MB floor — prevents slurmstepd termination
  SystemdTimeout?: number;       // ms for cgroup cleanup (default 1000)
}

// ── Switch ───────────────────────────────────────────────────────────
// Maps to stanzas in /etc/slurm/topology.conf.
// Required when TopologyPlugin=topology/tree is set in slurm.conf.
// Enables co-location of NCCL/MPI jobs on the same network switch.

export const Switch = createResource("Slurm::Conf::Switch", "slurm", {});

export interface SwitchProps {
  SwitchName: string;   // unique identifier (max 64 chars)
  Nodes?: string;       // leaf nodes (NodeName expression); mutually exclusive with Switches
  Switches?: string;    // child switch names; mutually exclusive with Nodes
  LinkSpeed?: number;   // MB/s (informational; currently unused by scheduler)
}
