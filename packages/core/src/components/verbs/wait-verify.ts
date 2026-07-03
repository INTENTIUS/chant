/**
 * wait / verify family — poll until a deploy reaches a terminal or healthy
 * state. Split across the cloud boundary: `wait-for-stack` is CFN-specific;
 * `health-gate` / `wait-endpoint` are agnostic (see docs/components/cloud-boundary).
 *
 * `wait-for-stack`, `wait-steady-state`, and `wait-cluster-healthy` are real
 * implementations (#557, epic #551) over the injectable `CloudExecutor`
 * (./cloud-executor.ts): `wait-cluster-healthy` is the Neo4j bolt/quorum probe
 * this issue scopes explicitly. `wait-endpoint`/`wait-job`/`health-gate` are
 * non-AWS-leaf/non-pilot verbs and stay typed stubs — out of scope for #557;
 * see ../capability.ts for the "no cloud implementation yet" contract.
 */

import type { Capability } from "../capability";
import { stubCapability } from "./stub";
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

/**
 * Poll a CloudFormation stack until it reaches a terminal status. No
 * rollback: a wait is a read-only observation, never a mutation — nothing to
 * compensate.
 */
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

/** Default `wait-for-stack` capability, backed by the real `CloudExecutor`. */
export const waitForStack: Capability<WaitForStackInput, WaitForStackOutput> = createWaitForStackCapability();

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

/**
 * Poll an ECS service (`DescribeServices`) until its running count matches
 * desired count and no deployment is still in flight. No rollback: read-only
 * observation.
 */
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

/** Default `wait-steady-state` capability, backed by the real `CloudExecutor`. */
export const waitSteadyState: Capability<WaitSteadyStateInput, WaitSteadyStateOutput> =
  createWaitSteadyStateCapability();

// ── wait-cluster-healthy ─────────────────────────────────────────────────────

export interface WaitClusterHealthyInput {
  /**
   * Cluster identifier — a comma-separated list of `host:port` bolt
   * endpoints. Optional because a per-instance fan-out phase (e.g. the Neo4j
   * pilot) calls this once per instance without repeating the cluster's
   * member list on every step; when omitted, falls back to
   * `ctx.vars.clusterEndpoints` (env config resolved by the caller) or,
   * failing that, `ctx.component` as a single-endpoint identifier.
   */
  cluster?: string;
  /** Minimum healthy member count required. */
  size?: number;
  /** Require quorum (majority of expected members healthy) rather than an exact size. Default: false. */
  quorum?: boolean;
  /** Poll interval in ms. Default: 5000. */
  intervalMs?: number;
  /** Overall timeout in ms. Default: 5 minutes. */
  timeoutMs?: number;
}

export interface WaitClusterHealthyOutput {
  /** Number of healthy members observed. */
  healthyCount: number;
}

/**
 * Poll a multi-node cluster (e.g. Neo4j) via a bolt-port TCP probe until it
 * reports healthy: `size` members reachable (exact-count mode, used by a
 * cluster's seed instance) or a majority of the expected member list
 * (`quorum` mode, used once followers exist). No rollback: a health probe is
 * read-only.
 */
export function createWaitClusterHealthyCapability(
  executor: CloudExecutor = defaultCloudExecutor(),
): Capability<WaitClusterHealthyInput, WaitClusterHealthyOutput> {
  return {
    kind: "wait-cluster-healthy",
    async run(ctx, input) {
      const cluster = input.cluster ?? (ctx.vars?.clusterEndpoints as string | undefined) ?? ctx.component;
      const intervalMs = input.intervalMs ?? 5_000;
      const deadline = Date.now() + (input.timeoutMs ?? 5 * 60_000);
      while (true) {
        const { healthyCount, total } = await executor.neo4j.probe({ cluster });
        const required = input.quorum ? Math.floor(total / 2) + 1 : (input.size ?? total);
        if (healthyCount >= required) return { healthyCount };
        if (Date.now() > deadline) {
          throw new Error(
            `wait-cluster-healthy "${cluster}" timed out: ${healthyCount}/${total} healthy, needed ${required}`,
          );
        }
        await sleep(intervalMs);
      }
    },
  };
}

/** Default `wait-cluster-healthy` capability, backed by the real `CloudExecutor`. */
export const waitClusterHealthy: Capability<WaitClusterHealthyInput, WaitClusterHealthyOutput> =
  createWaitClusterHealthyCapability();

// ── wait-endpoint ────────────────────────────────────────────────────────────

export interface WaitEndpointInput {
  /** URL to poll. */
  url: string;
  /** Expected HTTP status codes. Default: [200]. */
  expectStatus?: number[];
  /** Poll interval in ms. Default: 5000. */
  intervalMs?: number;
  /** Overall timeout in ms. */
  timeoutMs?: number;
}

export interface WaitEndpointOutput {
  /** Observed status code on success. */
  status: number;
}

/** Poll an HTTP(S) endpoint until it responds with an expected status. Cloud-agnostic. */
export const waitEndpoint: Capability<WaitEndpointInput, WaitEndpointOutput> = stubCapability(
  "wait-endpoint",
);

// ── wait-job ─────────────────────────────────────────────────────────────────

export interface WaitJobInput {
  /** Job/step run id (e.g. from `emr-start-job-run` or `emr-submit-step`). */
  runId: string;
  /** Poll interval in ms. Default: 10000. */
  intervalMs?: number;
}

export interface WaitJobOutput {
  /** Terminal job state (`COMPLETED`, `FAILED`, `CANCELLED`). */
  state: string;
}

/** Poll a submitted job/step until it reaches a terminal state. */
export const waitJob: Capability<WaitJobInput, WaitJobOutput> = stubCapability("wait-job");

// ── health-gate ──────────────────────────────────────────────────────────────

export interface HealthGateInput {
  /** Health check path or full URL. */
  path: string;
  /** Number of consecutive successes required. Default: 1. */
  consecutiveSuccesses?: number;
  /** Poll interval in ms. Default: 5000. */
  intervalMs?: number;
}

export interface HealthGateOutput {
  /** True once the health check passed the required consecutive count. */
  healthy: boolean;
}

/** Block progression until a health check passes — the generic post-deploy verification gate. Cloud-agnostic. */
export const healthGate: Capability<HealthGateInput, HealthGateOutput> = stubCapability(
  "health-gate",
);
