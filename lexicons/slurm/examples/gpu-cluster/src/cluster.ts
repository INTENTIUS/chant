import { Cluster, GpuPartition, Node, Partition } from "@intentius/chant-lexicon-slurm";

export const cluster = new Cluster({
  ClusterName: "gpu-hpc",
  ControlMachine: "head01",
  AuthType: "auth/munge",
  SelectType: "select/cons_tres",
  SelectTypeParameters: "CR_Core_Memory",
  ProctrackType: "proctrack/cgroup",
  GresTypes: "gpu",
  PriorityType: "priority/multifactor",
  PriorityWeightFairshare: 10000,
  PriorityWeightAge: 1000,
});

export const loginNodes = new Node({
  NodeName: "login[01-02]",
  CPUs: 32,
  RealMemory: 131072,
  State: "UNKNOWN",
});

export const { nodes: gpuNodes, partition: gpuPartition } = GpuPartition({
  partitionName: "gpu",
  nodePattern: "gpu[001-008]",
  gpuTypeCount: "a100:8",
  cpusPerNode: 96,
  memoryMb: 1_048_576,
  maxTime: "1-00:00:00",
});

export const loginPartition = new Partition({
  PartitionName: "login",
  Nodes: "login[01-02]",
  Default: "YES",
  MaxTime: "4:00:00",
  State: "UP",
});
