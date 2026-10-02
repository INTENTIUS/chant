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

import { parseDuration } from "./duration";

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
   * A command chant did not write and cannot know is safe to repeat (#2411).
   *
   * `shellCmd` is the escape hatch: its whole purpose is to run something
   * outside the model, so nothing here can judge whether a second attempt is
   * harmless or a second deployment. Every other activity carrying a retrying
   * profile is one chant authored and knows the shape of.
   *
   * Twenty minutes, because a shell step is as likely to be a long build as a
   * quick script, and one attempt, because retrying is the claim that needs
   * evidence. An author who knows their command is idempotent names
   * `fastIdempotent` or `longInfra` and gets retries back.
   */
  atMostOnce: {
    timeout: "20m",
    retry: { maximumAttempts: 1 },
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

/**
 * The longest timeout one step may declare for itself (#2787): six hours, the
 * ceiling hosted CI puts on a single job. A step's own `timeout` replaces its
 * profile's and keeps the profile's retries, so a builder `shell` step can
 * run 45 minutes on its one attempt. Anything that waits longer is waiting on
 * someone, which is a gate's job (`humanGate`, 48 hours), not a step's.
 */
export const MAX_STEP_TIMEOUT = "6h";

/** {@link MAX_STEP_TIMEOUT} in milliseconds. */
export const MAX_STEP_TIMEOUT_MS = 6 * 3_600_000;

/**
 * Why `timeout` can't be a step's own timeout, or null when it can: it must
 * be a duration such as `45m` or `1h30m`, more than zero, and at most
 * {@link MAX_STEP_TIMEOUT}.
 */
export function stepTimeoutProblem(timeout: unknown): string | null {
  if (typeof timeout !== "string" || !/^(\d+(ms|s|m|h|d))+$/.test(timeout)) {
    return `timeout ${JSON.stringify(timeout)} is not a duration such as "45m" or "1h30m"`;
  }
  const ms = parseDuration(timeout);
  if (ms <= 0) return `timeout "${timeout}" must be more than zero`;
  if (ms > MAX_STEP_TIMEOUT_MS) return `timeout "${timeout}" is longer than a step may run (${MAX_STEP_TIMEOUT}); a longer wait is a gate's`;
  return null;
}
