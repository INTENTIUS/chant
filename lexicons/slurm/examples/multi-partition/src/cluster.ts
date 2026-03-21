import { Cluster, Partition, Node } from "@intentius/chant-lexicon-slurm";

export const cluster = new Cluster({
  ClusterName: "hpc",
  ControlMachine: "head01",
  AuthType: "auth/munge",
  SelectType: "select/cons_tres",
  SelectTypeParameters: "CR_Core_Memory",
  ProctrackType: "proctrack/cgroup",
  AccountingStorageType: "accounting_storage/slurmdbd",
  AccountingStorageHost: "head01",
  AccountingStorageEnforce: "associations,limits,qos",
  PriorityType: "priority/multifactor",
  PriorityWeightFairshare: 10000,
});

export const cpuNodes = new Node({
  NodeName: "cpu[001-016]",
  CPUs: 96,
  RealMemory: 196608,
  State: "UNKNOWN",
});

export const hiMemNodes = new Node({
  NodeName: "himem[001-004]",
  CPUs: 96,
  RealMemory: 786432,
  State: "UNKNOWN",
});

export const cpuPartition = new Partition({
  PartitionName: "cpu",
  Nodes: "cpu[001-016]",
  Default: "YES",
  MaxTime: "7-00:00:00",
  DefMemPerCPU: 2048,
});

export const hiMemPartition = new Partition({
  PartitionName: "himem",
  Nodes: "himem[001-004]",
  Default: "NO",
  MaxTime: "2-00:00:00",
  DefMemPerCPU: 8192,
});
