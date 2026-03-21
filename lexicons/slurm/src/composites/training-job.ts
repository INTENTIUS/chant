/**
 * TrainingJob composite — a Slurm job submission for multi-node GPU training.
 *
 * Pre-wires common patterns for distributed ML training:
 * - Exclusive node allocation
 * - NCCL/GRES GPU assignment
 * - Standard output/error paths with job ID substitution
 * - MPI/NCCL environment defaults
 */

import type { Job as JobConstructor } from "../generated/index";

// We can't import the generated constructor class directly (it's created via
// createResource at runtime). Use a type-safe factory wrapper instead.
const { Job } = require("../generated/index") as { Job: typeof JobConstructor };

export interface TrainingJobConfig {
  /** Job name */
  name: string;
  /** Slurm account for fairshare accounting */
  account: string;
  /** Target partition (must have GPU GRES configured) */
  partition: string;
  /** Number of nodes */
  nodeCount: number;
  /**
   * GPU type and count per node for --gres (e.g. "a100:8").
   * Generates: gres_per_node: "gpu:a100:8"
   */
  gpuTypeCount: string;
  /** CPUs per task (for GPU training: typically cores_per_socket) */
  cpusPerTask: number;
  /** Time limit in minutes */
  timeLimit: number;
  /** Working directory on shared storage */
  workdir: string;
  /** Log directory prefix (default: workdir + "/logs") */
  logDir?: string;
  /** The training script content or path hint */
  script: string;
  /** QoS name (optional) */
  qos?: string;
  /** Extra environment variables */
  environment?: Record<string, string>;
  /**
   * EDA license requirements (e.g. { "eda_sim": 4 })
   * Generates: licenses="eda_sim:4"
   */
  licenses?: Record<string, number>;
}

/**
 * Create a TrainingJob resource pre-configured for multi-node GPU training.
 *
 * @example
 * ```typescript
 * export const llmTraining = TrainingJob({
 *   name: "llm-pretrain-7b",
 *   account: "ml_team",
 *   partition: "gpu_eda",
 *   nodeCount: 4,
 *   gpuTypeCount: "a100:8",
 *   cpusPerTask: 12,
 *   timeLimit: 10080,
 *   workdir: "/scratch/ml",
 *   script: "#!/bin/bash\ntorchrun --nproc_per_node=8 train.py",
 * });
 * ```
 */
export function TrainingJob(config: TrainingJobConfig): InstanceType<typeof JobConstructor> {
  const logDir = config.logDir ?? `${config.workdir}/logs`;
  const licensesStr = config.licenses
    ? Object.entries(config.licenses).map(([k, v]) => `${k}:${v}`).join(",")
    : undefined;

  const env: Record<string, string> = {
    NCCL_DEBUG: "INFO",
    NCCL_IB_DISABLE: "0",
    ...config.environment,
  };

  return new Job({
    name: config.name,
    account: config.account,
    partition: config.partition,
    node_count: config.nodeCount,
    cpus_per_task: config.cpusPerTask,
    gres_per_node: `gpu:${config.gpuTypeCount}`,
    exclusive: true,
    time_limit: config.timeLimit,
    current_working_directory: config.workdir,
    standard_output: `${logDir}/%j.out`,
    standard_error: `${logDir}/%j.err`,
    environment: env,
    ...(config.qos && { qos: config.qos }),
    ...(licensesStr && { licenses: licensesStr }),
    script: config.script,
  });
}
