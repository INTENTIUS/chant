/**
 * k3d SimpleConfig schema fetching — downloads the JSON Schema and
 * caches it locally.
 */

import { join } from "path";
import { homedir } from "os";
import { fetchWithCache, clearCacheFile } from "@intentius/chant/codegen/fetch";

/**
 * Pinned upstream k3d release.
 *
 * The schema is fetched from the tagged source tree, not a moving branch:
 * https://raw.githubusercontent.com/k3d-io/k3d/v5.9.0/pkg/config/v1alpha5/schema.json
 *
 * v1alpha5 is the config apiVersion this lexicon models. Older config
 * versions (v1alpha2..v1alpha4) each ship their own migrate.go upstream —
 * k3d migrates old configs itself, so modelling superseded versions here
 * would duplicate upstream's job. Bump this constant (and re-generate)
 * when adopting a newer k3d release.
 */
export const K3D_VERSION = "v5.9.0";

const SCHEMA_URL = `https://raw.githubusercontent.com/k3d-io/k3d/${K3D_VERSION}/pkg/config/v1alpha5/schema.json`;

/**
 * Get the cache file path for the k3d schema.
 */
export function getCachePath(): string {
  return join(homedir(), ".chant", `k3d-schema-${K3D_VERSION}.json`);
}

/**
 * Fetch the k3d SimpleConfig JSON Schema.
 * Uses local file caching with 24-hour TTL.
 */
export async function fetchConfigSchema(force?: boolean): Promise<Buffer> {
  return fetchWithCache(
    {
      url: SCHEMA_URL,
      cacheFile: getCachePath(),
    },
    force,
  );
}

/**
 * Fetch the config schema as a Map<typeName, Buffer> compatible with the
 * generatePipeline fetchSchemas callback.
 *
 * Single document keyed by "K3d::Cluster" — the parse step splits it into
 * multiple entities.
 */
export async function fetchSchemas(force?: boolean): Promise<Map<string, Buffer>> {
  const data = await fetchConfigSchema(force);
  const schemas = new Map<string, Buffer>();
  schemas.set("K3d::Cluster", data);
  return schemas;
}

/**
 * Clear the cached schema file.
 */
export function clearCache(): void {
  clearCacheFile(getCachePath());
}
