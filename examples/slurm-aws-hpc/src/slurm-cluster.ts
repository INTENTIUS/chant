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
} from "@intentius/chant-lexicon-slurm";
import { config } from "./config";

// ── Cluster globals ───────────────────────────────────────────────

export const cluster = new Cluster({
  ClusterName: config.clusterName,
  ControlMachine: "head01",
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
  AccountingStorageHost: "head01",
  AccountingStorageEnforce: "associations,limits,qos",

  // GPU GRES — must match gres.conf AutoDetect=nvml on GPU nodes
  GresTypes: "gpu",

  // EDA license pool — Slurm queues jobs if tokens are exhausted
  Licenses: `eda_synth:${config.licenses.eda_synth},eda_sim:${config.licenses.eda_sim},calibre_drc:${config.licenses.calibre_drc}`,

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
});

// ── CPU compute nodes (synthesis + simulation) ────────────────────

export const cpuNodes = new Node({
  NodeName: "cpu[001-032]",
  CPUs: 36,               // c5.9xlarge: 36 vCPU, 72 GB RAM
  RealMemory: 71680,      // MB (leave 4GB for OS)
  State: "CLOUD",         // CLOUD: nodes start stopped, Slurm provisions on demand
});

// ── GPU compute nodes (EDA AI tools + multi-node training) ────────

export const { nodes: gpuNodes, partition: gpuPartition } = GpuPartition({
  partitionName: "gpu_eda",
  nodePattern: "gpu[001-016]",
  gpuTypeCount: "a100:8",   // 8×A100-80GB per p4d.24xlarge
  cpusPerNode: 96,
  memoryMb: 1_044_480,       // 1020 GB (p4d.24xlarge has 1096 GB, leave headroom)
  maxTime: "1-00:00:00",     // EDA AI tools: 24h max (prevent runaway jobs)
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
});

export const simPartition = new Partition({
  PartitionName: "sim",
  Nodes: "cpu[017-032]",         // next 16 nodes → simulation
  Default: "NO",
  MaxTime: "7-00:00:00",         // 168h: formal verification can take days
  Priority: 30,
  DefMemPerCPU: 4096,            // 4 GB/CPU (gate-level sim is memory-heavy)
  State: "UP",
});

// ── License declarations (individual entities → aggregated Licenses= line) ─

export const synthLicense = new License({ LicenseName: "eda_synth", Count: config.licenses.eda_synth });
export const simLicense = new License({ LicenseName: "eda_sim", Count: config.licenses.eda_sim });
export const drcLicense = new License({ LicenseName: "calibre_drc", Count: config.licenses.calibre_drc });
