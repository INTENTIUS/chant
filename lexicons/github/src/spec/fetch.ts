/**
 * GitHub Actions workflow schema fetching — downloads the JSON Schema
 * and caches it locally.
 */

import { join } from "path";
import { homedir } from "os";
import { fetchWithCache, clearCacheFile } from "@intentius/chant/codegen/fetch";

/**
 * Schema URL from SchemaStore.
 */
const SCHEMA_URL = "https://json.schemastore.org/github-workflow.json";

/**
 * Get the cache file path for the workflow schema.
 */
export function getCachePath(): string {
  return join(homedir(), ".chant", "github-workflow-schema.json");
}

/**
 * Fetch the GitHub Actions Workflow JSON Schema.
 * Uses local file caching with 24-hour TTL.
 */
export async function fetchWorkflowSchema(force?: boolean): Promise<Buffer> {
  return fetchWithCache(
    {
      url: SCHEMA_URL,
      cacheFile: getCachePath(),
    },
    force,
  );
}

/**
 * Fetch the workflow schema as a Map<typeName, Buffer>
 * compatible with the generatePipeline fetchSchemas callback.
 *
 * Single document keyed by "GitHub::Actions::Workflow" — the parse
 * step will split it into multiple entities.
 */
export async function fetchSchemas(force?: boolean): Promise<Map<string, Buffer>> {
  const data = await fetchWorkflowSchema(force);
  const schemas = new Map<string, Buffer>();
  schemas.set("GitHub::Actions::Workflow", data);
  return schemas;
}

/**
 * Clear the cached schema file.
 */
export function clearCache(): void {
  clearCacheFile(getCachePath());
}
