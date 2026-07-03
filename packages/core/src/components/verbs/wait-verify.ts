/**
 * wait / verify family — poll until a deploy reaches a terminal or healthy
 * state. Split across the cloud boundary: `wait-for-stack` is CFN-specific;
 * `health-gate` / `wait-endpoint` are agnostic (see docs/components/cloud-boundary).
 *
 * Typed stubs only; see ../capability.ts for the "no cloud implementation yet" contract.
 */

import type { Capability } from "../capability";
import { stubCapability } from "./stub";

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

/** Poll a CloudFormation stack until it reaches a terminal status. */
export const waitForStack: Capability<WaitForStackInput, WaitForStackOutput> = stubCapability(
  "wait-for-stack",
);

// ── wait-steady-state ────────────────────────────────────────────────────────

export interface WaitSteadyStateInput {
  /** Service identifier (e.g. an ECS service name). */
  service: string;
  /** Poll interval in ms. Default: 10000. */
  intervalMs?: number;
}

export interface WaitSteadyStateOutput {
  /** Running task/instance count once steady state is reached. */
  runningCount: number;
}

/** Poll a service (e.g. ECS) until its running count matches desired count. */
export const waitSteadyState: Capability<WaitSteadyStateInput, WaitSteadyStateOutput> =
  stubCapability("wait-steady-state");

// ── wait-cluster-healthy ─────────────────────────────────────────────────────

export interface WaitClusterHealthyInput {
  /** Cluster identifier. */
  cluster: string;
  /** Minimum healthy member count required. */
  size?: number;
  /** Require quorum (majority of expected members healthy) rather than an exact size. Default: false. */
  quorum?: boolean;
}

export interface WaitClusterHealthyOutput {
  /** Number of healthy members observed. */
  healthyCount: number;
}

/** Poll a multi-node cluster (e.g. Neo4j, a database cluster) until it reports healthy/quorum. */
export const waitClusterHealthy: Capability<WaitClusterHealthyInput, WaitClusterHealthyOutput> =
  stubCapability("wait-cluster-healthy");

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
