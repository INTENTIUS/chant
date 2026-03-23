---
name: generate-job
description: Generate a Slurm batch job submission TypeScript declaration
triggers:
  - "generate a slurm job"
  - "create a batch job"
  - "submit a job to slurm"
  - "slurm job template"
preConditions:
  - "A chant project with the slurm lexicon is open"
postConditions:
  - "A new Job resource is added to the project"
parameters:
  - name: jobName
    description: "Name for the job"
    required: true
  - name: partition
    description: "Target partition"
    required: false
  - name: nodeCount
    description: "Number of nodes"
    required: false
examples:
  - input: "generate a GPU training job on the gpu_eda partition with 4 nodes"
    output: |
      export const gpuTrainingJob = new Job({
        name: "gpu-training",
        partition: "gpu_eda",
        node_count: 4,
        cpus_per_task: 96,
        gres_per_node: "gpu:a100:8",
        time_limit: 1440,
        script: "#!/bin/bash\n#SBATCH --output=/scratch/logs/%j.out\npython train.py",
      });
---

Generate a Slurm `Job` resource for the chant-lexicon-slurm package.

## Requirements

- Import `Job` from `@intentius/chant-lexicon-slurm`
- Set at minimum: `name`, `partition`, `script`
- For GPU jobs: add `gres_per_node: "gpu:<type>:<count>"` and `exclusive: true`
- Use `time_limit` in minutes (1440 = 24h)
- `standard_output` pattern: `/scratch/logs/%j.out` (job ID substitution)

## Example output

```typescript
import { Job } from "@intentius/chant-lexicon-slurm";

export const myJob = new Job({
  name: "simulation-run",
  account: "eda_team",
  partition: "sim",
  node_count: 16,
  cpus_per_task: 8,
  time_limit: 10080,  // 7 days
  current_working_directory: "/scratch/sim",
  standard_output: "/scratch/logs/%j.out",
  standard_error: "/scratch/logs/%j.err",
  licenses: "eda_sim:4",
  script: "#!/bin/bash\n#SBATCH --export=ALL\n./run_sim.sh",
});
```
