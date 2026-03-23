/**
 * EDA HPC Slurm cluster configuration.
 *
 * This is the core chant-lexicon-slurm output. Three partitions:
 *   - synthesis: c5.2xlarge, MaxTime=48h — Verilog synthesis, place-and-route
 *   - sim:       c5.2xlarge, MaxTime=168h — gate-level simulation, formal verification
 *   - gpu_eda:   p4d.24xlarge+EFA, MaxTime=24h — ML-driven optimization, AI EDA tools
 *
 * License management: Slurm tracks license tokens natively (no FlexLM integration).
 * Jobs request licenses via --licenses=eda_synth:1 — Slurm queues if tokens exhausted.
 *
 * Accounting: slurmdbd on Aurora MySQL enforces per-team QOS limits and fairshare.
 * SuspendProgram/ResumeProgram: scale the GPU ASG via AWS CLI hooks.
 */

import {
  Cluster,
  Node,
  Partition,
  License,
  GpuPartition,
  CgroupConf,
  Switch,
} from "@intentius/chant-lexicon-slurm";
import { config } from "./config";

// ── Cluster globals ───────────────────────────────────────────────

export const cluster = new Cluster({
  ClusterName: config.clusterName,
  // ControlMachine is required by slurm.conf but the actual hostname is resolved
  // at runtime. enable_configless broadcasts config automatically so nodes don't
  // need a hard-coded host. head01 is a placeholder — slurmctld replaces it at boot.
  ControlMachine: "head01",
  SlurmctldParameters: "enable_configless",
  AuthType: "auth/munge",

  // cons_tres: allocates CPUs + memory per-task (required for EDA license accuracy)
  SelectType: "select/cons_tres",
  SelectTypeParameters: "CR_Core_Memory",

  // cgroup v2: reliable job cleanup, required when EDA tools fork many processes
  ProctrackType: "proctrack/cgroup",

  // Prevents InfiniBand MPI from hitting MEMLOCK limits (standard OpenHPC config)
  PropagateResourceLimitsExcept: "MEMLOCK",

  // slurmdbd on Aurora MySQL — enables QOS enforcement and fairshare
  AccountingStorageType: "accounting_storage/slurmdbd",
  AccountingStorageHost: "localhost",   // slurmdbd runs on the same node as slurmctld
  AccountingStorageEnforce: "associations,limits,qos",
  StateSaveLocation: "/scratch/slurm/state",  // FSx-backed — survives head node replacement

  // GPU GRES — must match gres.conf AutoDetect=nvml on GPU nodes
  GresTypes: "gpu",

  // License pool is declared via License entities below — do not duplicate here.

  // Multifactor priority: fairshare dominates (10000 >> age 1000 >> job-size 500)
  PriorityType: "priority/multifactor",
  PriorityWeightFairshare: 10000,
  PriorityWeightAge: 1000,
  PriorityWeightJobSize: 500,
  PriorityDecayHalfLife: "7-0",      // fairshare half-life = 1 week

  // Cloud bursting: scale GPU ASG via suspend/resume hooks
  // SuspendProgram: called when node goes idle → scale ASG DesiredCapacity down
  // ResumeProgram:  called when job queued → scale ASG DesiredCapacity up
  SuspendProgram: "/usr/local/bin/slurm_suspend_node",
  ResumeProgram: "/usr/local/bin/slurm_resume_node",
  SuspendTime: 300,       // idle for 5 min → suspend
  ResumeTimeout: 600,     // 10 min to provision + join cluster

  // CLOUD nodes must be able to re-register after spot resume
  ReturnToService: 1,

  // pmi2 is the default available in EPEL 20.11.9 on Amazon Linux 2.
  // pmix requires a separately-compiled package not in EPEL.
  MpiDefault: "pmi2",
  TaskPlugin: "task/cgroup",

  // Faster DOWN detection for spot instances (default is 300s)
  SlurmdTimeout: 30,

  // Network topology for NCCL/MPI job co-location on EFA
  TopologyPlugin: "topology/tree",

  // Preemption: QOS-based so low-priority jobs can be requeued by high-priority ones.
  // PreemptMode=CANCEL is required when PreemptType=preempt/qos (OFF is incompatible).
  PreemptType: "preempt/qos",
  PreemptMode: "CANCEL",
});

// ── CPU compute nodes (synthesis + simulation) ────────────────────

export const cpuNodes = new Node({
  NodeName: "cpu[001-032]",
  CPUs: 8,                // c5.2xlarge: 8 vCPU, 16 GB RAM (within default On-Demand Standard vCPU quota)
  RealMemory: 14336,      // MB (leave 2GB for OS)
  Sockets: 2,
  CoresPerSocket: 2,      // c5.2xlarge: 2 sockets × 2 cores × 2 HT = 8 vCPU
  ThreadsPerCore: 2,
  State: "CLOUD",         // CLOUD: nodes start stopped, Slurm provisions on demand
});

// ── GPU compute nodes (EDA AI tools + multi-node training) ────────

export const { nodes: gpuNodes, partition: gpuPartition, gresNode } = GpuPartition({
  partitionName: "gpu_eda",
  nodePattern: "gpu[001-016]",
  gpuTypeCount: "a100:8",   // 8×A100-80GB per p4d.24xlarge
  cpusPerNode: 96,
  memoryMb: 1_044_480,       // 1020 GB (p4d.24xlarge has 1096 GB, leave headroom)
  maxTime: "1-00:00:00",     // EDA AI tools: 24h max (prevent runaway jobs)
  socketsPerNode: 2,
  coresPerSocket: 48,        // p4d.24xlarge: 2 sockets × 48 cores × 1 HT = 96 vCPU
  threadsPerCore: 1,         // disable HT for GPU jobs (NCCL latency)
  gresConf: { autoDetect: "nvml" }, // NVML auto-detects A100 devices in gres.conf
});

// ── EDA partitions ────────────────────────────────────────────────

export const synthesisPartition = new Partition({
  PartitionName: "synthesis",
  Nodes: "cpu[001-016]",         // first 16 nodes → synthesis
  Default: "YES",
  MaxTime: "2-00:00:00",         // 48h: RTL→GDS can take 36h on large designs
  Priority: 50,
  DefMemPerCPU: 2048,            // 2 GB/CPU default (synthesis is memory-light)
  State: "UP",
  // PowerDownOnIdle and per-partition SuspendTime require Slurm 21.08+.
  // Use the global SuspendTime=300 (cluster level) for CLOUD node power-down.
});

export const simPartition = new Partition({
  PartitionName: "sim",
  Nodes: "cpu[017-032]",         // next 16 nodes → simulation
  Default: "NO",
  MaxTime: "7-00:00:00",         // 168h: formal verification can take days
  Priority: 30,
  DefMemPerCPU: 1792,            // 1792 MB/CPU = 14336 MB / 8 CPUs (c5.2xlarge constraint)
  State: "UP",
  // PowerDownOnIdle and per-partition SuspendTime require Slurm 21.08+.
  // Use the global SuspendTime=300 (cluster level) for CLOUD node power-down.
});

// ── License declarations (individual entities → aggregated Licenses= line) ─

export const synthLicense = new License({ LicenseName: "eda_synth", Count: config.licenses.eda_synth });
export const simLicense = new License({ LicenseName: "eda_sim", Count: config.licenses.eda_sim });
export const drcLicense = new License({ LicenseName: "calibre_drc", Count: config.licenses.calibre_drc });

// ── cgroup.conf — enforce memory/core/device isolation ────────────
// Required when ProctrackType=proctrack/cgroup. Without this file,
// ConstrainRAMSpace defaults to false and runaway EDA jobs can OOM the node.

export const cgroupConf = new CgroupConf({
  // CgroupPlugin (cgroup/v1 vs v2) requires Slurm 21.08+. AL2 EPEL ships 20.11.9
  // which uses cgroup v1 implicitly. Omitting CgroupPlugin uses the default (v1).
  ConstrainRAMSpace: true,
  ConstrainCores: true,
  ConstrainDevices: true,   // GPU device isolation via gres.conf AutoDetect=nvml
  AllowedRAMSpace: 95,      // allow 95% of allocation (5% slack prevents false OOM kills)
  MinRAMSpace: 30,          // MB floor — prevents slurmstepd from being terminated
});

// ── topology.conf — switch topology for NCCL co-location and CPU ──
// topology/tree requires ALL nodes to be reachable through the switch
// tree. CPU nodes (Ethernet) need their own switch entry or slurmctld
// will log "switches lack access to N nodes" and CLOUD nodes won't be
// schedulable (jobs fail with BadConstraints instead of pending).

export const efaSwitch = new Switch({
  SwitchName: "efa",
  Nodes: "gpu[001-016]",
});

export const ethernetSwitch = new Switch({
  SwitchName: "ethernet",
  Nodes: "cpu[001-032]",
});
