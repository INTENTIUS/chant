/**
 * wait / verify family — poll until a deploy reaches a terminal or healthy
 * state. The *agnostic* members live here: `wait-cluster-healthy` (a Neo4j
 * bolt/quorum probe over the core `CloudExecutor`), and the HTTP waits
 * `wait-endpoint` / `health-gate` (over an injectable `fetch`). The
 * cloud-specific members — `wait-for-stack` (CloudFormation),
 * `wait-steady-state` (ECS), `wait-job` (EMR) — moved to the aws lexicon
 * alongside their executor clients (see docs/components/cloud-boundary).
 */

import type { Capability } from "../capability";
import { defaultCloudExecutor, sleep, type CloudExecutor } from "./cloud-executor";

/** Minimal fetch surface the HTTP waits (`wait-endpoint`, `health-gate`) need — injectable for tests. */
type Fetcher = (url: string) => Promise<{ status: number; ok: boolean }>;
const defaultFetcher: Fetcher = (url) => fetch(url);

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
export const waitClusterHealthyCapability: Capability<WaitClusterHealthyInput, WaitClusterHealthyOutput> =
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
export function createWaitEndpointCapability(fetcher: Fetcher = defaultFetcher): Capability<WaitEndpointInput, WaitEndpointOutput> {
  return {
    kind: "wait-endpoint",
    async run(_ctx, input) {
      const expect = input.expectStatus ?? [200];
      const intervalMs = input.intervalMs ?? 5_000;
      const timeoutMs = input.timeoutMs ?? 5 * 60_000;
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        try {
          const res = await fetcher(input.url);
          if (expect.includes(res.status)) return { status: res.status };
        } catch {
          // not reachable yet — keep polling until the deadline
        }
        if (Date.now() >= deadline) {
          throw new Error(`wait-endpoint: ${input.url} did not return ${expect.join("/")} within ${timeoutMs}ms`);
        }
        await sleep(intervalMs);
      }
    },
  };
}

/** Default `wait-endpoint` capability, backed by the global `fetch`. */
export const waitEndpointCapability: Capability<WaitEndpointInput, WaitEndpointOutput> = createWaitEndpointCapability();

// ── health-gate ──────────────────────────────────────────────────────────────

export interface HealthGateInput {
  /** Health check path or full URL. */
  path: string;
  /** Optional base URL (scheme + host) composed with `path` via `new URL(path, host)`. May be a cross-stack Wiring value; a bare host gets `http://` prepended. */
  host?: string;
  /** Number of consecutive successes required. Default: 1. */
  consecutiveSuccesses?: number;
  /** Poll interval in ms. Default: 5000. */
  intervalMs?: number;
}

export interface HealthGateOutput {
  /** True once the health check passed the required consecutive count. */
  healthy: boolean;
}

/** Compose the fetchable URL: `host` set → resolve `path` against it (bare host → `http://` prepended); else `path` as-is. */
function healthGateUrl(input: HealthGateInput): string {
  if (!input.host) return input.path;
  const base = /^https?:\/\//.test(input.host) ? input.host : `http://${input.host}`;
  return new URL(input.path, base).toString();
}

/** Block progression until a health check passes — the generic post-deploy verification gate. Cloud-agnostic. */
export function createHealthGateCapability(fetcher: Fetcher = defaultFetcher): Capability<HealthGateInput, HealthGateOutput> {
  return {
    kind: "health-gate",
    async run(_ctx, input) {
      const need = input.consecutiveSuccesses ?? 1;
      const intervalMs = input.intervalMs ?? 5_000;
      // HealthGateInput has no timeout field; cap the wait so a never-healthy target fails rather than hangs.
      const deadline = Date.now() + 5 * 60_000;
      let streak = 0;
      for (;;) {
        let ok = false;
        try {
          ok = (await fetcher(healthGateUrl(input))).ok;
        } catch {
          ok = false;
        }
        streak = ok ? streak + 1 : 0;
        if (streak >= need) return { healthy: true };
        if (Date.now() >= deadline) {
          throw new Error(`health-gate: ${healthGateUrl(input)} did not reach ${need} consecutive healthy check(s) within 300000ms`);
        }
        await sleep(intervalMs);
      }
    },
  };
}

/** Default `health-gate` capability, backed by the global `fetch`. */
export const healthGateCapability: Capability<HealthGateInput, HealthGateOutput> = createHealthGateCapability();
