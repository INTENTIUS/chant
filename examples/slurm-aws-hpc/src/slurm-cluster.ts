/**
 * EDA HPC Slurm cluster configuration.
 *
 * This is the core chant-lexicon-slurm output. Three partitions:
 *   - synthesis: c5.9xlarge, MaxTime=48h — Verilog synthesis, place-and-route
 *   - sim:       c5.9xlarge, MaxTime=168h — gate-level simulation, formal verification
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

  // LBNL NHC: run on any node every 30s to catch hardware failures early
  HealthCheckProgram: "/usr/sbin/nhc",
  HealthCheckInterval: 30,
  HealthCheckNodeState: "ANY",

  // PMIx for both OpenMPI (EDA sim) and NCCL (GPU training)
  MpiDefault: "pmix",
  TaskPlugin: "task/cgroup",

  // Faster DOWN detection for spot instances (default is 300s)
  SlurmdTimeout: 30,

  // Network topology for NCCL/MPI job co-location on EFA
  TopologyPlugin: "topology/tree",

  // GPU power via NVML — no RAPL on AWS instances (RAPL requires bare-metal CPU counters)
  AcctGatherEnergyType: "acct_gather_energy/gpu",
  AcctGatherNodeFreq: 30,

  // Preemption: QOS-based so low-priority jobs can be requeued by high-priority ones
  PreemptType: "preempt/qos",
});

// ── CPU compute nodes (synthesis + simulation) ────────────────────

export const cpuNodes = new Node({
  NodeName: "cpu[001-032]",
  CPUs: 36,               // c5.9xlarge: 36 vCPU, 72 GB RAM
  RealMemory: 71680,      // MB (leave 4GB for OS)
  Sockets: 2,
  CoresPerSocket: 9,      // c5.9xlarge: 2 sockets × 9 cores × 2 HT = 36 vCPU
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
  PowerDownOnIdle: "YES",        // terminate idle nodes as soon as last job finishes
  SuspendTime: 600,              // 10 min idle before suspend — avoids churn during EDA job bursts
});

export const simPartition = new Partition({
  PartitionName: "sim",
  Nodes: "cpu[017-032]",         // next 16 nodes → simulation
  Default: "NO",
  MaxTime: "7-00:00:00",         // 168h: formal verification can take days
  Priority: 30,
  DefMemPerCPU: 4096,            // 4 GB/CPU (gate-level sim is memory-heavy)
  State: "UP",
  PowerDownOnIdle: "YES",        // terminate idle nodes as soon as last job finishes
  SuspendTime: 600,              // 10 min idle before suspend — sim jobs have high restart cost
});

// ── License declarations (individual entities → aggregated Licenses= line) ─

export const synthLicense = new License({ LicenseName: "eda_synth", Count: config.licenses.eda_synth });
export const simLicense = new License({ LicenseName: "eda_sim", Count: config.licenses.eda_sim });
export const drcLicense = new License({ LicenseName: "calibre_drc", Count: config.licenses.calibre_drc });

// ── cgroup.conf — enforce memory/core/device isolation ────────────
// Required when ProctrackType=proctrack/cgroup. Without this file,
// ConstrainRAMSpace defaults to false and runaway EDA jobs can OOM the node.

export const cgroupConf = new CgroupConf({
  CgroupPlugin: "cgroup/v2",
  ConstrainRAMSpace: true,
  ConstrainCores: true,
  ConstrainDevices: true,   // GPU device isolation via gres.conf AutoDetect=nvml
  AllowedRAMSpace: 95,      // allow 95% of allocation (5% slack prevents false OOM kills)
  MinRAMSpace: 30,          // MB floor — prevents slurmstepd from being terminated
});

// ── topology.conf — EFA flat topology for NCCL co-location ───────
// All GPU nodes share the same EFA placement group / switch.
// TopologyPlugin=topology/tree above instructs Slurm to use this file.

export const efaSwitch = new Switch({
  SwitchName: "efa",
  Nodes: "gpu[001-016]",
});
