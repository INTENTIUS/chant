/**
 * GitLab CI schema fetching — downloads the CI JSON Schema
 * and caches it locally.
 */

import { join, dirname } from "path";
import { homedir } from "os";
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { fetchWithCache, clearCacheFile } from "@intentius/chant/codegen/fetch";

/**
 * Pinned schema version — a GitLab release tag that produces a known-good
 * schema. Override at runtime with `--schema-version <tag>` in generate-cli
 * or by setting `schemaVersion` in the generate options.
 *
 * Using a tag (e.g. "v17.8.1-ee") rather than `master` ensures reproducible
 * codegen across environments and CI runs.
 */
export const GITLAB_SCHEMA_VERSION = "v17.8.1-ee";

/**
 * Build the schema URL for a given version ref.
 */
function schemaUrl(version: string): string {
  return `https://gitlab.com/gitlab-org/gitlab/-/raw/${version}/app/assets/javascripts/editor/schema/ci.json`;
}

/**
 * Get the cache file path for the CI schema.
 */
export function getCachePath(): string {
  return join(homedir(), ".chant", "gitlab-ci-schema.json");
}

/**
 * Path to the vendored CI schema committed in this lexicon. Reading it offline
 * is the default so `generate` never depends on gitlab.com — which aggressively
 * 429-rate-limits the raw endpoint and chronically flaked CI (#574). The
 * `GITLAB_SCHEMA_VERSION` pin already makes the fetch deterministic, so a
 * committed copy is equivalent and network-free.
 */
export function getVendoredSchemaPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "vendored", "gitlab-ci-schema.json");
}

/**
 * Fetch the GitLab CI JSON Schema, returning the raw JSON buffer.
 *
 * Default (pinned version, no force): read the vendored, committed schema —
 * offline, deterministic, no gitlab.com 429s (#574). Pass `force` or a custom
 * `version` to fetch live — used to verify against upstream or to refresh the
 * vendored copy when bumping the pin (see {@link refreshVendoredSchema}).
 *
 * @param force  Bypass the vendored copy and download fresh.
 * @param version  GitLab ref (tag, branch, or SHA) to fetch from.
 *                 Defaults to {@link GITLAB_SCHEMA_VERSION}.
 */
export async function fetchCISchema(force?: boolean, version?: string): Promise<Buffer> {
  const ref = version ?? GITLAB_SCHEMA_VERSION;
  if (!force && ref === GITLAB_SCHEMA_VERSION) {
    return readFileSync(getVendoredSchemaPath());
  }
  return fetchWithCache(
    {
      url: schemaUrl(ref),
      cacheFile: getCachePath(),
    },
    force,
  );
}

/**
 * Refresh the vendored schema from upstream. Call this when bumping
 * `GITLAB_SCHEMA_VERSION` so the committed copy tracks the new pin — the
 * lexicon-upgrade pipeline (#523) runs it as part of a gitlab pin bump.
 * Fetches the given version live and overwrites the vendored file.
 */
export async function refreshVendoredSchema(version?: string): Promise<void> {
  const ref = version ?? GITLAB_SCHEMA_VERSION;
  const data = await fetchWithCache({ url: schemaUrl(ref), cacheFile: getCachePath() }, true);
  writeFileSync(getVendoredSchemaPath(), data);
}

/**
 * Fetch the CI schema and return it as a Map<typeName, Buffer>
 * compatible with the generatePipeline fetchSchemas callback.
 *
 * The CI schema is a single document, so we return a single entry
 * keyed by "GitLab::CI::Pipeline" — the parse step will split it
 * into multiple entities.
 */
export async function fetchSchemas(force?: boolean, version?: string): Promise<Map<string, Buffer>> {
  const data = await fetchCISchema(force, version);
  const schemas = new Map<string, Buffer>();
  schemas.set("GitLab::CI::Pipeline", data);
  return schemas;
}

/**
 * Clear the cached schema file.
 */
export function clearCache(): void {
  clearCacheFile(getCachePath());
}
