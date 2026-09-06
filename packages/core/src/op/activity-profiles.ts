/**
 * Activity timeout and retry profiles.
 *
 * A profile is a named retry/timeout shape an Op step opts into
 * (`activity("chantBuild", …, "fastIdempotent")`), so tuning lives in one table
 * instead of inline at every call site. The six names cover the shapes infra
 * steps actually take: fast idempotent work, long infra, K8s wait loops, a
 * human gate, an Argo sync wait, and a deterministic policy check.
 *
 * These lived in a hosting lexicon, under its own prefixed name, until chant
 * #2114 moved the base activities into core. Nothing about a timeout or a
 * backoff coefficient belonged to that runtime, so the table came with them and
 * lost the prefix. `heartbeatTimeout` did not come along: it configured a
 * liveness protocol between a worker and a server, and no in-process step
 * heartbeats to anything.
 */

export interface ActivityProfile {
  /** Maximum time allowed for a single activity execution attempt (e.g. `"20m"`). */
  timeout: string;
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
    /**
     * Error names (`Error.name`) that fail immediately without retry — the
     * executor short-circuits its retry loop on a match.
     */
    nonRetryableErrorTypes?: string[];
  };
}

/** Named activity profiles for common infrastructure step patterns. */
export const ACTIVITY_PROFILES = {
  /**
   * Fast, idempotent operations: `chant build`, `kubectl apply` without `--wait`,
   * fetching nameservers, reading cluster status.
   */
  fastIdempotent: {
    timeout: "5m",
    retry: { maximumAttempts: 3, initialInterval: "5s", backoffCoefficient: 2 },
  },

  /**
   * Long-running infra: GKE cluster creation via Config Connector (~10-20 min),
   * `kubectl apply --wait` for large resource sets, Helm installs.
   */
  longInfra: {
    timeout: "20m",
    retry: { maximumAttempts: 3, initialInterval: "30s", backoffCoefficient: 2 },
  },

  /**
   * K8s wait loops: polling for StatefulSet rollout, ExternalDNS A-records,
   * DNS propagation.
   */
  k8sWait: {
    timeout: "15m",
    // A terminal-state resource (waitForReady's ReadinessFailedError) will never
    // become ready — fail fast instead of exhausting retries.
    retry: {
      maximumAttempts: 3,
      initialInterval: "10s",
      backoffCoefficient: 2,
      nonRetryableErrorTypes: ["ReadinessFailedError"],
    },
  },

  /**
   * Human-gate steps: waiting for an operator action (DNS delegation, approval).
   * Very long timeout, single attempt — no retry on human-gate timeouts.
   */
  humanGate: {
    timeout: "48h",
    retry: { maximumAttempts: 1 },
  },

  /**
   * Argo CD sync waits: poll an Application until `health=Healthy && sync=Synced`
   * (`waitForArgoSync`). Long timeout for slow first syncs, cheap idempotent
   * retries — re-polling is free. A terminal-unhealthy Application fails fast
   * via `ArgoSyncFailedError` (non-retryable).
   */
  argoSync: {
    timeout: "30m",
    retry: {
      maximumAttempts: 5,
      initialInterval: "10s",
      backoffCoefficient: 2,
      maximumInterval: "1m",
      nonRetryableErrorTypes: ["ArgoSyncFailedError"],
    },
  },

  /**
   * Organizational policy gate (`policyGate`): build the project and evaluate
   * `lint.policies`. Deterministic — a violation is the same on every attempt —
   * so a single attempt, short timeout, no retry.
   */
  policyCheck: {
    timeout: "5m",
    retry: { maximumAttempts: 1 },
  },
} as const satisfies Record<string, ActivityProfile>;

/** The name of a built-in activity profile — the union `ActivityStep.profile` admits. */
export type ActivityProfileName = keyof typeof ACTIVITY_PROFILES;

/** Every profile name, as a runtime list (`KNOWN_ACTIVITY_PROFILES`'s source). */
export const ACTIVITY_PROFILE_NAMES = Object.keys(ACTIVITY_PROFILES) as ActivityProfileName[];
