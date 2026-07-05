/**
 * wait / verify family — the cloud-specific members, owned by the aws lexicon:
 * `wait-for-stack` (CloudFormation), `wait-steady-state` (ECS), `wait-job`
 * (EMR). The agnostic waits (`wait-cluster-healthy`, `wait-endpoint`,
 * `health-gate`) stay in core. All poll a real cloud through the injectable aws
 * `CloudExecutor` (./cloud-executor.ts); none has a rollback — a wait is a
 * read-only observation, never a mutation.
 */

import type { Capability } from "@intentius/chant/components/capability";
import { defaultCloudExecutor, sleep, type CloudExecutor } from "./cloud-executor";

// ── wait-for-stack ───────────────────────────────────────────────────────────

export interface WaitForStackInput {
  /** CloudFormation stack name. */
  stack: string;
  /** Poll interval in ms. Default: 10000. */
  intervalMs?: number;
  /** Overall timeout in ms. */
  timeoutMs?: number;
}

export interface WaitForStackOutput {
  /** Terminal stack status (`CREATE_COMPLETE`, `UPDATE_COMPLETE`, ...). */
  stackStatus: string;
}

/** Poll a CloudFormation stack until it reaches a terminal status. No rollback: a wait is a read-only observation. */
export function createWaitForStackCapability(
  executor: CloudExecutor = defaultCloudExecutor(),
): Capability<WaitForStackInput, WaitForStackOutput> {
  return {
    kind: "wait-for-stack",
    async run(_ctx, input) {
      const { stackStatus } = await executor.cloudformation.waitForStack(input.stack, {
        intervalMs: input.intervalMs,
        timeoutMs: input.timeoutMs,
      });
      return { stackStatus };
    },
  };
}

/** Default `wait-for-stack` capability, backed by the real aws `CloudExecutor`. */
export const waitForStackCapability: Capability<WaitForStackInput, WaitForStackOutput> = createWaitForStackCapability();

// ── wait-steady-state ────────────────────────────────────────────────────────

export interface WaitSteadyStateInput {
  /** Service identifier (e.g. an ECS service name). */
  service: string;
  /** ECS cluster name/ARN the service lives in. Default: "default". */
  cluster?: string;
  /** Poll interval in ms. Default: 10000. */
  intervalMs?: number;
  /** Overall timeout in ms. Default: 10 minutes. */
  timeoutMs?: number;
}

export interface WaitSteadyStateOutput {
  /** Running task/instance count once steady state is reached. */
  runningCount: number;
}

/** Poll an ECS service until running count matches desired and no deployment is in flight. No rollback: read-only. */
export function createWaitSteadyStateCapability(
  executor: CloudExecutor = defaultCloudExecutor(),
): Capability<WaitSteadyStateInput, WaitSteadyStateOutput> {
  return {
    kind: "wait-steady-state",
    async run(_ctx, input) {
      const cluster = input.cluster ?? "default";
      const intervalMs = input.intervalMs ?? 10_000;
      const deadline = Date.now() + (input.timeoutMs ?? 10 * 60_000);
      while (true) {
        const state = await executor.ecs.describeService(cluster, input.service);
        if (state.stable) return { runningCount: state.runningCount };
        if (Date.now() > deadline) {
          throw new Error(`wait-steady-state "${input.service}" timed out before reaching steady state`);
        }
        await sleep(intervalMs);
      }
    },
  };
}

/** Default `wait-steady-state` capability, backed by the real aws `CloudExecutor`. */
export const waitSteadyStateCapability: Capability<WaitSteadyStateInput, WaitSteadyStateOutput> =
  createWaitSteadyStateCapability();

// ── wait-job ─────────────────────────────────────────────────────────────────

export interface WaitJobInput {
  /** Job/step run id (e.g. from `emr-start-job-run` or `emr-submit-step`). */
  runId: string;
  /** Poll interval in ms. Default: 10000. */
  intervalMs?: number;
  /** Overall timeout in ms. */
  timeoutMs?: number;
}

export interface WaitJobOutput {
  /** Terminal job state (`COMPLETED`, `FAILED`, `CANCELLED`). */
  state: string;
}

/**
 * Poll a submitted job/step (e.g. an EMR job run started by `emr-start-job-run`)
 * until it reaches a terminal state, failing the step if that state is not
 * `COMPLETED`. No rollback: read-only observation.
 */
export function createWaitJobCapability(
  executor: CloudExecutor = defaultCloudExecutor(),
): Capability<WaitJobInput, WaitJobOutput> {
  return {
    kind: "wait-job",
    async run(_ctx, input) {
      const { state } = await executor.emr.waitForJobRun(input.runId, {
        intervalMs: input.intervalMs,
        timeoutMs: input.timeoutMs,
      });
      if (state !== "COMPLETED") {
        throw new Error(`wait-job "${input.runId}" ended in terminal state "${state}", expected "COMPLETED"`);
      }
      return { state };
    },
  };
}

/** Default `wait-job` capability, backed by the real aws `CloudExecutor`. */
export const waitJobCapability: Capability<WaitJobInput, WaitJobOutput> = createWaitJobCapability();
