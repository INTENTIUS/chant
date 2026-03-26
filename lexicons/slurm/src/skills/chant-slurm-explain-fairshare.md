---
name: chant-slurm-explain-fairshare
description: Explain Slurm multifactor priority and fairshare scheduling configuration
triggers:
  - "explain slurm fairshare"
  - "how does slurm priority work"
  - "configure multifactor priority"
  - "slurm qos priority"
preConditions: []
postConditions:
  - "User understands how to configure PriorityType=priority/multifactor"
parameters: []
examples:
  - input: "explain how to configure fairshare for a multi-team EDA cluster"
    output: |
      # Slurm Multifactor Priority for EDA

      Configure priority/multifactor with meaningful weights:

      export const cluster = new Cluster({
        PriorityType: "priority/multifactor",
        PriorityWeightFairshare: 10000,  // dominates priority
        PriorityWeightAge: 1000,          // older jobs get slight boost
        PriorityWeightJobSize: 100,       // prefer larger jobs (fill nodes)
        PriorityDecayHalfLife: "14-0",    // 14-day decay
      });
---

# Slurm Multifactor Priority

Slurm's multifactor priority combines several factors into a single job priority score:

```
Priority = w_fairshare * (1 - usage/shares) + w_age * age_factor + w_size * size_factor
```

## Key parameters

| Parameter | Recommended (EDA) | Description |
|-----------|---------------------|-------------|
| `PriorityWeightFairshare` | 10000 | Weight for fairshare component — must be large to matter |
| `PriorityWeightAge` | 1000 | Older jobs get a small boost |
| `PriorityWeightJobSize` | 100 | Larger jobs slightly preferred (fill nodes) |
| `PriorityDecayHalfLife` | `"14-0"` | Usage decays to 50% in 14 days |

## Fairshare mechanics

- Each account gets a share of the cluster (set via `sacctmgr modify account`)
- `usage/shares` ratio: > 1 means the account has over-used its share → lower priority
- Half-life decay means bursts don't permanently penalize teams
- With `PriorityWeightFairshare < 1000`, fairshare has negligible effect (SLR021 catches this)

## QoS in chant

```typescript
export const highPriorityQos = new QoS({
  name: "high",
  priority: 1000,
  max_wall_clock_per_job: 86400,  // 24h max
  max_nodes_per_user: 8,
});
```

Submit jobs to this QoS: `qos: "high"` in your Job resource.
