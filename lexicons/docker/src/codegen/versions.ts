/**
 * Pinned URLs and version tags for upstream Docker specs.
 */

/**
 * Pinned commit of compose-spec/compose-spec (#1146).
 *
 * compose-spec/compose-spec has no tagged releases, so unlike
 * ENGINE_API_URL below (pinned to the `v27.3.1` tag) there is no version tag
 * to pin against — codegen used to fetch the default branch directly (the
 * repo's default branch is `main`; the old URL fetched `master`, a legacy
 * alias GitHub still redirects, but a moving-branch alias all the same).
 * That meant a cold cache picked up whatever upstream state had landed since
 * the cache last expired, while a warm cache kept serving whatever was
 * current when it was last filled — the exact CI nondeterminism this fix
 * closed for azure (#1144).
 *
 * Pinning to a commit SHA makes generation reproducible regardless of cache
 * state. Bump policy: #523's scheduled lexicon-upgrade cron (rolling-spec
 * bucket) is meant to propose bumps to this constant as a reviewable PR once
 * built. Until then, bump by hand: take the current `main` HEAD sha from
 * https://github.com/compose-spec/compose-spec/commits/main, regenerate, fix
 * up any composite left referencing a renamed or vanished export, and update
 * this constant + comment.
 */
export const COMPOSE_SPEC_COMMIT = "11296e387ba76c77db1db768b9153a4304a3c9bd";

/** Compose Spec JSON Schema — pinned to COMPOSE_SPEC_COMMIT, not a moving branch */
export const COMPOSE_SPEC_URL = `https://raw.githubusercontent.com/compose-spec/compose-spec/${COMPOSE_SPEC_COMMIT}/schema/compose-spec.json`;

/** Docker Engine API OpenAPI spec (v1.45) */
export const ENGINE_API_URL =
  "https://raw.githubusercontent.com/moby/moby/v27.3.1/api/swagger.yaml";

/**
 * Cache filenames under ~/.chant/.
 *
 * COMPOSE_SPEC_CACHE embeds the pin so a stale schema file fetched before a
 * bump can never satisfy the new pin: restoring an old ~/.chant (e.g. a CI
 * cache partial-key fallback, or a developer's pre-existing cache) simply
 * misses this filename and re-downloads, instead of silently serving
 * pre-bump schema under a name that still matches (#1146, mirroring azure's
 * AZURE_SCHEMA_COMMIT-keyed cache filename, #1144).
 */
export const COMPOSE_SPEC_CACHE = `docker-compose-spec-${COMPOSE_SPEC_COMMIT}.json`;
export const ENGINE_API_CACHE = "docker-engine-api.yaml";
