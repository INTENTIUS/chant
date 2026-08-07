/**
 * aws-warden public surface (#792, epic #787).
 *
 * The provider-agnostic reconcile harness is consumed from
 * `@intentius/chant/reconcile` — it is not vendored here. Individual cycles
 * are reachable via the registry (keyed by cycle name) or by deep import
 * (`@intentius/aws-warden/cycles/<name>`).
 */

// Signed AWS client (Organizations + CloudTrail, SigV4, no SDK)
export { createClient, credentialsFromEnv, AwsApiError } from "./auth/client.js";
export type { AwsClient, AwsClientOptions, AwsService } from "./auth/client.js";
export { signRequest } from "./auth/sigv4.js";
export type { Sigv4Credentials } from "./auth/sigv4.js";

// Config types (the shapes a governance.yml deserializes into; contract with
// the lexicon's landingZoneConfig — see config/types.test.ts)
export * from "./config/types.js";

// Reconcile: live-state fetch, diff, guardrails, runner
export * from "./reconcile/live.js";
export * from "./reconcile/diff.js";
export * from "./reconcile/guardrails.js";
export * from "./reconcile/runner.js";

// Cycle registry — every cycle, keyed by its `--cycles` name
export { CYCLE_REGISTRY } from "./cli/registry.js";
