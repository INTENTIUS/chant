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
 * Activity timeout and retry profiles.
 *
 * The table itself moved to core as `ACTIVITY_PROFILES` (chant #2114) — a
 * timeout and a backoff coefficient were never Temporal's. These two names are
 * kept as aliases so `@intentius/chant-lexicon-temporal/config` (which the
 * generated workflow imports) and every existing `TEMPORAL_ACTIVITY_PROFILES`
 * call site resolve unchanged until #2116 deletes this lexicon.
 *
 * The table is derived rather than re-exported, because `proxyActivities`
 * validates the object it is handed: core spells the field `timeout`, Temporal
 * requires `startToCloseTimeout`. `heartbeatTimeout` is gone on purpose —
 * `safeHeartbeat` is a no-op now, and an activity declaring a heartbeat timeout
 * it never meets would be failed by the server for going silent.
 *
 * Sourced from core's profile leaf rather than its `op` barrel: this module is
 * what the generated workflow imports, and the barrel reaches node:fs/child_process
 * through the activity registry — which the Temporal workflow sandbox forbids.
 */
import type { TemporalConfig } from "./config-schema";
import { ACTIVITY_PROFILES, type ActivityProfile } from "@intentius/chant/op/activity-profiles";

export interface TemporalActivityProfile {
  /** Maximum time allowed for a single activity execution attempt. Core's `timeout`. */
  startToCloseTimeout: string;
  /** Retry policy for failed activity attempts — passed through unchanged. */
  retry?: ActivityProfile["retry"];
}

export const TEMPORAL_ACTIVITY_PROFILES: Record<keyof typeof ACTIVITY_PROFILES, TemporalActivityProfile> =
  Object.fromEntries(
    Object.entries(ACTIVITY_PROFILES).map(([name, profile]) => [
      name,
      { startToCloseTimeout: profile.timeout, ...(profile.retry ? { retry: profile.retry } : {}) },
    ]),
  ) as Record<keyof typeof ACTIVITY_PROFILES, TemporalActivityProfile>;

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

/**
 * The `temporal` namespace, derived from the schema core validates against
 * (#1344) rather than declared a second time here. Kept as a name because
 * projects `satisfies TemporalChantConfig` against it; `ChantConfig` itself now
 * carries the key, so `satisfies ChantConfig` works too.
 */
export type TemporalChantConfig = TemporalConfig;
