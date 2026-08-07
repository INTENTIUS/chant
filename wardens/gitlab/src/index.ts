/**
 * gitlab-warden public surface (#789).
 *
 * The provider-agnostic reconcile harness is consumed from
 * `@intentius/chant/reconcile` — it is not vendored here. Individual cycles
 * are reachable via the registry (keyed by cycle name) or by deep import
 * (`@intentius/gitlab-warden/cycles/<name>`).
 */

// GitLab REST client
export { createClient, encodeId, GitLabApiError } from "./auth/client.js";
export type { GitLabClient, GitLabClientOptions } from "./auth/client.js";

// Config types (the shapes a governance.yml deserializes into)
export * from "./config/types.js";
export * from "./config/access-levels.js";

// Reconcile: diff, live-state fetch, runner
export * from "./reconcile/diff.js";
export * from "./reconcile/live.js";
export * from "./reconcile/runner.js";

// Cycle registry — every cycle, keyed by its `--cycles` name
export { CYCLE_REGISTRY } from "./cli/registry.js";
