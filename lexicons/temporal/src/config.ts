/**
 * Temporal worker profile — connection configuration for `chant run`.
 *
 * Add this to `chant.config.ts` to define how chant connects to Temporal:
 *
 * ```ts
 * import type { TemporalChantConfig } from "@intentius/chant-lexicon-temporal";
 *
 * export default {
 *   lexicons: ["temporal"],
 *   temporal: {
 *     profiles: {
 *       local: {
 *         address: "localhost:7233",
 *         namespace: "default",
 *         taskQueue: "my-deploy",
 *         autoStart: true,
 *       },
 *       cloud: {
 *         address: "myns.a2dd6.tmprl.cloud:7233",
 *         namespace: "myns.a2dd6",
 *         taskQueue: "my-deploy",
 *         tls: true,
 *         apiKey: { env: "TEMPORAL_API_KEY" },
 *       },
 *     },
 *     defaultProfile: "local",
 *   } satisfies TemporalChantConfig,
 * };
 * ```
 *
 * ChantConfig uses `.passthrough()` in its Zod schema so the `temporal` key
 * is accepted at runtime without core changes. Issue #8 (`chant run`) will
 * read these profiles when starting workers.
 */

/**
 * Activity timeout and retry configuration for infrastructure activity groups.
 *
 * Pre-built profiles match the four activity groups typically seen in infra workflows:
 * fast/idempotent operations, long-running infra (GKE, kubectl apply --wait),
 * K8s wait loops, and human-gate activities.
 *
 * @example
 * ```ts
 * import { TEMPORAL_ACTIVITY_PROFILES } from "@intentius/chant-lexicon-temporal";
 * import { proxyActivities } from "@temporalio/workflow";
 *
 * const { applyInfra } = proxyActivities<typeof infraActivities>(
 *   TEMPORAL_ACTIVITY_PROFILES.longInfra
 * );
 * ```
 */
export interface TemporalActivityProfile {
  /** Maximum time allowed for a single activity execution attempt. */
  startToCloseTimeout: string;
  /**
   * Time after the last heartbeat before Temporal marks the activity as timed out.
   * Required for activities that call `activity.heartbeat()` to signal liveness.
   */
  heartbeatTimeout?: string;
  /** Retry policy for failed activity attempts. */
  retry?: {
    /** Initial wait before the first retry (e.g. "5s"). */
    initialInterval?: string;
    /** Multiplier applied to the interval on each retry (e.g. 2). */
    backoffCoefficient?: number;
    /** Maximum number of attempts including the first (0 = unlimited). */
    maximumAttempts?: number;
    /** Cap on retry intervals (e.g. "5m"). */
    maximumInterval?: string;
  };
}

/**
 * Named activity profiles for common infrastructure workflow patterns.
 *
 * Import and spread into `proxyActivities()` so retry/timeout configuration
 * lives in the lexicon rather than inline in workflow code.
 */
export const TEMPORAL_ACTIVITY_PROFILES = {
  /**
   * Fast, idempotent operations: `chant build`, `kubectl apply` without `--wait`,
   * fetching nameservers, reading cluster status.
   */
  fastIdempotent: {
    startToCloseTimeout: "5m",
    retry: { maximumAttempts: 3, initialInterval: "5s", backoffCoefficient: 2 },
  },

  /**
   * Long-running infra: GKE cluster creation via Config Connector (~10-20 min),
   * `kubectl apply --wait` for large resource sets, Helm installs.
   * Must heartbeat; 60 s silence → Temporal marks the activity dead.
   */
  longInfra: {
    startToCloseTimeout: "20m",
    heartbeatTimeout: "60s",
    retry: { maximumAttempts: 3, initialInterval: "30s", backoffCoefficient: 2 },
  },

  /**
   * K8s wait loops: polling for StatefulSet rollout, ExternalDNS A-records,
   * DNS propagation. Medium timeout with heartbeating.
   */
  k8sWait: {
    startToCloseTimeout: "15m",
    heartbeatTimeout: "60s",
    retry: { maximumAttempts: 3, initialInterval: "10s", backoffCoefficient: 2 },
  },

  /**
   * Human-gate activities: waiting for an operator action (DNS delegation, approval).
   * Very long timeout, single attempt — no retry on human-gate timeouts.
   */
  humanGate: {
    startToCloseTimeout: "48h",
    heartbeatTimeout: "90s",
    retry: { maximumAttempts: 1 },
  },
} as const satisfies Record<string, TemporalActivityProfile>;

export interface TemporalWorkerProfile {
  /** Temporal server gRPC address. e.g. "localhost:7233" or "myns.a2dd6.tmprl.cloud:7233" */
  address: string;
  /** Temporal namespace to connect to */
  namespace: string;
  /** Task queue the worker polls */
  taskQueue: string;
  /** TLS configuration. Pass `true` or `{}` for Temporal Cloud default TLS */
  tls?: boolean | { serverNameOverride?: string };
  /**
   * API key for Temporal Cloud authentication.
   * String value: used as-is (Bearer token).
   * Object form: reads from process.env at runtime.
   */
  apiKey?: string | { env: string };
  /**
   * Automatically start `temporal server start-dev` before the worker.
   * Only applicable for local development profiles.
   */
  autoStart?: boolean;
}

export interface TemporalChantConfig {
  /** Named connection profiles */
  profiles: Record<string, TemporalWorkerProfile>;
  /** Profile used when --profile flag is omitted from `chant run` */
  defaultProfile?: string;
}
