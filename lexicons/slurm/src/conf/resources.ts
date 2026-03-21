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
