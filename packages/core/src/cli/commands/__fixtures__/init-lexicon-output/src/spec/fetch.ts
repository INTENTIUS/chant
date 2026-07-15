import { fetchWithCache, extractFromZip } from "@intentius/chant/codegen/fetch";

// TODO: Set this to your upstream schema source URL
const SCHEMA_URL = "https://example.com/schemas.zip";
const CACHE_FILE = ".cache/schemas.zip";

/**
 * Fetch upstream schemas with caching.
 *
 * TODO: Point SCHEMA_URL at your real upstream schema source.
 */
export async function fetchSchemas(options?: { force?: boolean }): Promise<Map<string, Buffer>> {
  // `force` is the second argument to fetchWithCache (not a FetchConfig field).
  const zipData = await fetchWithCache(
    { url: SCHEMA_URL, cacheFile: CACHE_FILE },
    options?.force,
  );

  // TODO: Adjust the filter to match your schema file names. extractFromZip yields
  // Buffers — decode with `.toString()` in parse.ts as needed.
  return extractFromZip(zipData, (name) => name.endsWith(".json"));
}
