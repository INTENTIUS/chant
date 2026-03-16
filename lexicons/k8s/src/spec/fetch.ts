/**
 * Kubernetes OpenAPI schema fetching — downloads the Swagger 2.0 spec
 * and caches it locally.
 */

import { join } from "path";
import { homedir } from "os";
import { fetchWithCache, clearCacheFile } from "@intentius/chant/codegen/fetch";

/**
 * Pinned Kubernetes version for schema download.
 */
export const K8S_SCHEMA_VERSION = "v1.32.0";

/**
 * Build the schema URL for a given version.
 */
function schemaUrl(version: string): string {
  return `https://raw.githubusercontent.com/kubernetes/kubernetes/${version}/api/openapi-spec/swagger.json`;
}

/**
 * Get the cache file path for the K8s schema.
 */
export function getCachePath(version?: string): string {
  const ref = version ?? K8S_SCHEMA_VERSION;
  return join(homedir(), ".chant", `k8s-swagger-${ref}.json`);
}

/**
 * Fetch the Kubernetes OpenAPI Swagger spec, returning the raw JSON buffer.
 * Uses local file caching with 24-hour TTL.
 *
 * @param force  Bypass cache and download fresh.
 * @param version  Kubernetes version tag. Defaults to {@link K8S_SCHEMA_VERSION}.
 */
export async function fetchK8sSchema(force?: boolean, version?: string): Promise<Buffer> {
  const ref = version ?? K8S_SCHEMA_VERSION;
  return fetchWithCache(
    {
      url: schemaUrl(ref),
      cacheFile: getCachePath(ref),
    },
    force,
  );
}

/**
 * Fetch the K8s schema and return it as a Map<typeName, Buffer>
 * compatible with the generatePipeline fetchSchemas callback.
 *
 * The K8s schema is a single document, so we return a single entry
 * keyed by "Kubernetes::OpenAPI" — the parse step will split it
 * into multiple resources.
 */
export async function fetchSchemas(force?: boolean, version?: string): Promise<Map<string, Buffer>> {
  const data = await fetchK8sSchema(force, version);
  const schemas = new Map<string, Buffer>();
  schemas.set("Kubernetes::OpenAPI", data);
  return schemas;
}

/**
 * Clear the cached schema file.
 */
export function clearCache(version?: string): void {
  clearCacheFile(getCachePath(version));
}
