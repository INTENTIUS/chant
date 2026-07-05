/**
 * job submission family — point a running compute service at an artifact.
 * Cloud-shaped (EMR here; the same shape reuses for Glue / Batch / Step
 * Functions / SageMaker per docs/components/cloud-boundary). Typically
 * consumes a producer component's published artifact, e.g.
 * `jar: "@jar-lib.publish.uri"`.
 *
 * `emr-start-job-run` is a real implementation (#561, epic #551) — just
 * enough against the injectable `CloudExecutor` (./cloud-executor.ts) to run
 * the JAR-producer -> EMR-consumer cross-component example end to end (a
 * mocked cloud is acceptable per #561's acceptance criteria; the full EMR
 * surface — retries, Serverless vs EMR-on-EC2 branching, Glue/Batch peers —
 * stays out of scope, per #561 explicitly deferring "the emr-start-job-run
 * cloud impl beyond what the example needs"). `emr-submit-step` is a
 * different verb (submit a step to an already-running EMR-on-EC2 cluster
 * rather than starting an ephemeral job run), also real over the executor
 * (`aws emr add-steps`) and unit-tested against the mock — the same
 * "mocked cloud is acceptable" basis #561 set for its sibling, since a live
 * long-running EMR cluster is not part of gating CI.
 */

import type { Capability } from "@intentius/chant/components/capability";
import { defaultCloudExecutor, type CloudExecutor } from "./cloud-executor";

// ── emr-start-job-run ────────────────────────────────────────────────────────

export interface EmrStartJobRunInput {
  /**
   * EMR (Serverless) application id, or EMR on EC2 cluster id. Optional here
   * (unlike the underlying `CloudExecutor.emr.startJobRun` args) because the
   * epic's worked JAR->EMR example (component-contract fixture
   * `../__fixtures__/emr-job-consumer.json`, docs/components/composition-and-wiring.mdx)
   * wires it as env config rather than a literal in the component
   * declaration; falls back to `ctx.vars.emrApplicationId`, matching how
   * `wait-cluster-healthy` (../verbs/wait-verify.ts) falls back to
   * `ctx.vars.clusterEndpoints` for the same reason (env resolution is the
   * caller's `DeployContext.vars`, not a literal every component must repeat).
   */
  clusterOrApplicationId?: string;
  /** Entry point artifact reference — resolved by the graph before this capability runs (e.g. from `"@jar-lib.publish.uri"` to a concrete S3 URI). */
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

/**
 * Start an EMR job run (Serverless application or EMR-on-EC2 cluster)
 * against a published artifact. `input.jar` arrives already resolved by the
 * driver's graph-driven wiring (`@<component>.publish.uri`) — this capability
 * never resolves the reference itself, keeping cross-component wiring
 * entirely the graph's job (../driver.ts's `resolveWiring`), never a
 * capability- or orchestrator-level special case. No rollback: starting a
 * job run has no "undo" that restores prior state — a failed/cancelled run
 * simply produced no usable output, matching `wait-for-stack`/`wait-job`'s
 * read-only-observation story (there is nothing to compensate for having
 * asked the cluster to run something).
 */
export function createEmrStartJobRunCapability(
  executor: CloudExecutor = defaultCloudExecutor(),
): Capability<EmrStartJobRunInput, EmrStartJobRunOutput> {
  return {
    kind: "emr-start-job-run",
    rollbackPolicy: "needs-opt-out",
    async run(ctx, input) {
      const clusterOrApplicationId =
        input.clusterOrApplicationId ?? (ctx.vars?.emrApplicationId as string | undefined) ?? ctx.component;
      const { runId } = await executor.emr.startJobRun({
        clusterOrApplicationId,
        jar: input.jar,
        args: input.args,
        executionRoleArn: input.executionRoleArn,
      });
      return { runId };
    },
  };
}

/** Default `emr-start-job-run` capability, backed by the real `CloudExecutor`. */
export const emrStartJobRunCapability: Capability<EmrStartJobRunInput, EmrStartJobRunOutput> =
  createEmrStartJobRunCapability();

// ── emr-submit-step ──────────────────────────────────────────────────────────

export interface EmrSubmitStepInput {
  /** EMR-on-EC2 cluster id to submit the step to. */
  clusterId: string;
  /** Step name, shown in the EMR console. */
  name: string;
  /** Entry point artifact reference (e.g. `"@jar-lib.publish.uri"`) — resolved by the graph before this capability runs, exactly like `emr-start-job-run`'s `jar`. */
  jar: string;
  /** Arguments passed to the step. */
  args?: string[];
  /** What EMR does if the step fails. Default: "CONTINUE". */
  actionOnFailure?: "CONTINUE" | "CANCEL_AND_WAIT" | "TERMINATE_CLUSTER";
}

export interface EmrSubmitStepOutput {
  /** EMR step id, for polling via `wait-job`. */
  stepId: string;
}

/**
 * Submit a step to a long-running EMR-on-EC2 cluster (as opposed to
 * `emr-start-job-run`, which starts an ephemeral Serverless/EC2 job run) via
 * `aws emr add-steps` through the injectable `CloudExecutor`. Returns the step
 * id for polling via `wait-job`. Like its sibling, `input.jar` arrives
 * already resolved by the driver's graph-driven wiring, and there is no
 * rollback — a submitted step has no "undo" that restores prior state.
 */
export function createEmrSubmitStepCapability(
  executor: CloudExecutor = defaultCloudExecutor(),
): Capability<EmrSubmitStepInput, EmrSubmitStepOutput> {
  return {
    kind: "emr-submit-step",
    rollbackPolicy: "needs-opt-out",
    async run(_ctx, input) {
      const { stepId } = await executor.emr.addStep({
        clusterId: input.clusterId,
        name: input.name,
        jar: input.jar,
        args: input.args,
        actionOnFailure: input.actionOnFailure,
      });
      return { stepId };
    },
  };
}

/** Default `emr-submit-step` capability, backed by the real `CloudExecutor`. */
export const emrSubmitStepCapability: Capability<EmrSubmitStepInput, EmrSubmitStepOutput> =
  createEmrSubmitStepCapability();
