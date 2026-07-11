import { fetchWithCache } from "@intentius/chant/codegen/fetch";

/** Fly's published Machines API (flaps) OpenAPI 3.0.1 spec. */
const SCHEMA_URL = "https://docs.machines.dev/openapi.json";
const CACHE_FILE = ".cache/openapi3.json";

/**
 * Fetch the flaps OpenAPI spec and return it as a Map<typeName, Buffer>
 * compatible with the generatePipeline fetchSchemas callback.
 *
 * The flaps spec is a single document, so we return a single entry keyed by
 * "Fly::OpenAPI" — the parse step splits it into the curated resources and
 * their reachable property types.
 */
export async function fetchSchemas(options?: { force?: boolean }): Promise<Map<string, Buffer>> {
  const raw = await fetchWithCache({ url: SCHEMA_URL, cacheFile: CACHE_FILE }, options?.force);
  return new Map([["Fly::OpenAPI", raw]]);
}
