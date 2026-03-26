---
name: chant-slurm-generate-cluster
description: Generate a complete Slurm cluster configuration with Cluster, Partition, and Node resources
triggers:
  - "generate a slurm cluster config"
  - "create slurm.conf"
  - "set up a slurm cluster"
  - "hpc cluster configuration"
preConditions:
  - "A chant project with the slurm lexicon is open"
postConditions:
  - "Cluster, Partition, and Node resources are generated"
parameters:
  - name: clusterName
    description: "Name for the Slurm cluster"
    required: true
  - name: controlMachine
    description: "Hostname of the head/controller node"
    required: true
  - name: gpuEnabled
    description: "Whether to include a GPU partition"
    required: false
examples:
  - input: "generate a GPU HPC cluster config for cluster hpc-prod with controller head01"
    output: |
      export const cluster = new Cluster({
        ClusterName: "hpc-prod",
        ControlMachine: "head01",
        AuthType: "auth/munge",
        SelectType: "select/cons_tres",
        SelectTypeParameters: "CR_Core_Memory",
        ProctrackType: "proctrack/cgroup",
        GresTypes: "gpu",
        AccountingStorageType: "accounting_storage/slurmdbd",
      });
---

Generate a Slurm cluster configuration using `Cluster`, `Partition`, and `Node` resources.

## Best practices applied

- `SelectType: "select/cons_tres"` (cons_res is deprecated since Slurm 21.08)
- `SelectTypeParameters: "CR_Core_Memory"` (required for memory tracking)
- `ProctrackType: "proctrack/cgroup"` (reliable job cleanup)
- `AuthType: "auth/munge"` (never use auth/none)
- `StateSaveLocation` on shared NFS (not local disk)

## Example output

```typescript
import { Cluster, Partition, Node } from "@intentius/chant-lexicon-slurm";

export const cluster = new Cluster({
  ClusterName: "hpc-prod",
  ControlMachine: "head01",
  AuthType: "auth/munge",
  StateSaveLocation: "/nfs/slurm/state",
  SelectType: "select/cons_tres",
  SelectTypeParameters: "CR_Core_Memory",
  ProctrackType: "proctrack/cgroup",
  PropagateResourceLimitsExcept: "MEMLOCK",
  GresTypes: "gpu",
  AccountingStorageType: "accounting_storage/slurmdbd",
  AccountingStorageHost: "db.internal",
  AccountingStorageEnforce: "associations,limits,qos",
  PriorityType: "priority/multifactor",
  PriorityWeightFairshare: 10000,
  PriorityWeightAge: 1000,
});

export const computeNodes = new Node({
  NodeName: "node[001-016]",
  CPUs: 96,
  RealMemory: 196608,
  Sockets: 2,
  CoresPerSocket: 24,
  ThreadsPerCore: 2,
  State: "UNKNOWN",
});

export const cpuPartition = new Partition({
  PartitionName: "cpu",
  Nodes: "node[001-016]",
  Default: "YES",
  MaxTime: "7-00:00:00",
  State: "UP",
  DefMemPerCPU: 2048,
});
```
