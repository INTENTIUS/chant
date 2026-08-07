/**
 * forgejo-warden public surface.
 *
 * Grows as the auth client, config/live types, diff, runner, and cycles land.
 * The provider-agnostic reconcile harness is consumed from
 * `@intentius/chant/reconcile` — it is not vendored here.
 */

// Forgejo REST client
export { createClient, ForgejoApiError } from "./auth/client.js";
export type { ForgejoClient, ForgejoClientOptions } from "./auth/client.js";
