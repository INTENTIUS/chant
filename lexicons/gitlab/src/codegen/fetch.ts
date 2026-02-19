/**
 * GitLab CI schema fetching — downloads the CI JSON Schema
 * and caches it locally.
 */

import { join } from "path";
import { homedir } from "os";
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
 * Fetch the GitLab CI JSON Schema, returning the raw JSON buffer.
 * Uses local file caching with 24-hour TTL.
 *
 * @param force  Bypass cache and download fresh.
 * @param version  GitLab ref (tag, branch, or SHA) to fetch from.
 *                 Defaults to {@link GITLAB_SCHEMA_VERSION}.
 */
export async function fetchCISchema(force?: boolean, version?: string): Promise<Buffer> {
  const ref = version ?? GITLAB_SCHEMA_VERSION;
  return fetchWithCache(
    {
      url: schemaUrl(ref),
      cacheFile: getCachePath(),
    },
    force,
  );
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
