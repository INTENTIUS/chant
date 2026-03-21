import { Cluster, Partition, Node } from "@intentius/chant-lexicon-slurm";

export const cluster = new Cluster({
  ClusterName: "test-cluster",
  ControlMachine: "head001",
  AuthType: "auth/munge",
  StateSaveLocation: "/shared/slurm/state",
  SlurmctldPort: 6817,
  SlurmdPort: 6818,
  SelectType: "select/cons_tres",
  SelectTypeParameters: "CR_Core_Memory",
  ProctrackType: "proctrack/cgroup",
});

export const cpuNode = new Node({
  NodeName: "cpu[001-004]",
  CPUs: 36,
  RealMemory: 128000,
  State: "UNKNOWN",
});

export const compute = new Partition({
  PartitionName: "compute",
  Nodes: "cpu[001-004]",
  Default: "YES",
  MaxTime: "48:00:00",
  State: "UP",
});
