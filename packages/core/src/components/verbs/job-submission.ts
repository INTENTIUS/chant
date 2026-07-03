/**
 * job submission family — point a running compute service at an artifact.
 * Cloud-shaped (EMR here; the same shape reuses for Glue / Batch / Step
 * Functions / SageMaker per docs/components/cloud-boundary). Typically
 * consumes a producer component's published artifact, e.g.
 * `jar: "@jar-lib.publish.uri"`.
 *
 * Typed stubs only; see ../capability.ts for the "no cloud implementation yet" contract.
 */

import type { Capability } from "../capability";
import { stubCapability } from "./stub";

// ── emr-start-job-run ────────────────────────────────────────────────────────

export interface EmrStartJobRunInput {
  /** EMR (Serverless) application id, or EMR on EC2 cluster id. */
  clusterOrApplicationId: string;
  /** Entry point artifact reference (e.g. `"@jar-lib.publish.uri"`). */
  jar: string;
  /** Arguments passed to the job's main class/entry point. */
  args?: string[];
  /** Execution role ARN. */
  executionRoleArn?: string;
}

export interface EmrStartJobRunOutput {
  /** EMR job run id, for polling via `wait-job`. */
  runId: string;
}

/** Start an EMR job run (Serverless application or EMR-on-EC2 cluster) against a published artifact. */
export const emrStartJobRun: Capability<EmrStartJobRunInput, EmrStartJobRunOutput> =
  stubCapability("emr-start-job-run");

// ── emr-submit-step ──────────────────────────────────────────────────────────

export interface EmrSubmitStepInput {
  /** EMR cluster id to submit the step to. */
  clusterId: string;
  /** Step name, shown in the EMR console. */
  name: string;
  /** Entry point artifact reference (e.g. `"@jar-lib.publish.uri"`). */
  jar: string;
  /** Arguments passed to the step. */
  args?: string[];
}

export interface EmrSubmitStepOutput {
  /** EMR step id, for polling via `wait-job`. */
  stepId: string;
}

/** Submit a step to a long-running EMR cluster (as opposed to starting an ephemeral job run). */
export const emrSubmitStep: Capability<EmrSubmitStepInput, EmrSubmitStepOutput> = stubCapability(
  "emr-submit-step",
);
