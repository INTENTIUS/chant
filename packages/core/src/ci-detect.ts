/**
 * The CI system a job runs on, read from its environment (#5170). Kept out
 * of ./pr-forge.ts, whose bundle a product posts with, and out of
 * ./ci-system.ts, which chant.config.ts's loader reads.
 */
import type { CiSystem } from "./ci-system";
import { detectForge } from "./pr-forge";

/**
 * The CI system a job runs on, or undefined outside a job chant knows. A
 * Prow job is told by `PROW_JOB_ID`, which Prow's pod utilities set in every
 * job's pod. Every other job runs on its forge's own CI, as `detectForge`
 * reads it.
 */
export function detectCi(env: Record<string, string | undefined> = process.env): CiSystem | undefined {
  if (env.PROW_JOB_ID?.trim()) return "prow";
  return detectForge(env);
}
