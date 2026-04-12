---
skill: chant-slurm
description: Build and manage Slurm HPC cluster configurations from a chant project
user-invocable: true
---

# Slurm HPC Cluster Operational Playbook

## How chant and Slurm relate

chant is a **synthesis compiler** — it compiles TypeScript source files into `slurm.conf` (and optionally `gres.conf`, job scripts). `chant build` does not touch the Slurm daemon; synthesis is pure and deterministic. Your job as an agent is to bridge synthesis and deployment:

- Use **chant** for: build, lint, diff (local config comparison)
- Use **SSH / scontrol / sinfo** for: applying configs, checking cluster state, and all runtime operations

The source of truth for cluster configuration is the TypeScript in `src/`. The generated `slurm.conf` is an intermediate artifact.

## Build and validate

### Build the config

```bash
chant build src/ --output slurm.conf
```

Options:
- `--format yaml` — not applicable for Slurm (output is always `slurm.conf` format)
- `--watch` — rebuild on source changes

### Lint the source

```bash
chant lint src/
```

Options:
- `--fix` — auto-fix violations where possible
- `--format sarif` — SARIF output for CI integration

### Validate with Slurm

```bash
slurmd -C          # show node hardware summary
scontrol show config   # show current running config
```

## Key resource types

| Type | Purpose |
|------|---------|
| `Cluster` | Top-level cluster config (`ClusterName`, `ControlMachine`, auth, scheduler) |
| `Node` | Node definition (`NodeName`, `CPUs`, `RealMemory`, `State`) |
| `Partition` | Partition / queue (`PartitionName`, `Nodes`, `MaxTime`, `Default`) |
| `GpuPartition` | Composite: GPU nodes + partition with GRES config |
| `SlurmdbdConfig` | Accounting daemon config |

## Common build patterns

### Scaffold a new cluster

```bash
chant init --lexicon slurm
```

This creates `src/cluster.ts` with a basic Cluster + Node + Partition.

### Add a GPU partition

```typescript
import { GpuPartition } from "@intentius/chant-lexicon-slurm";

export const { nodes: gpuNodes, partition: gpuPartition } = GpuPartition({
  partitionName: "gpu",
  nodePattern: "gpu[001-004]",
  gpuTypeCount: "a100:4",
  cpusPerNode: 64,
  memoryMb: 512_000,
  maxTime: "2-00:00:00",
});
```

## Deploying a new config

1. `chant build src/ --output slurm.conf` — synthesize
2. `chant lint src/` — check for issues
3. Copy `slurm.conf` to `/etc/slurm/` on the control node
4. `sudo scontrol reconfigure` — reload without restarting

## Troubleshooting

### Check cluster state

```bash
sinfo                    # partition / node overview
squeue                   # running and pending jobs
scontrol show nodes      # detailed node info
```

### Common issues

| Symptom | Likely cause |
|---------|-------------|
| Node in `DOWN` state | `slurmd` not running or can't reach `slurmctld` |
| Jobs stuck in `PD` (pending) | No nodes in correct partition, or resource limits exceeded |
| `slurmd` won't start | Config error — run `slurmd -D -vvv` to see details |
