import { fetchWithCache } from "@intentius/chant/codegen/fetch";

/** Fly's published Machines API (flaps) OpenAPI 3.0.1 spec. */
const SCHEMA_URL = "https://docs.machines.dev/spec/openapi3.json";
const CACHE_FILE = ".cache/openapi3.json";

/**
 * Fetch the flaps OpenAPI spec and split its `components.schemas` into one
 * schema per type, keyed by schema name (Machine, App, Volume, …). Each value is
 * the JSON of that component schema, ready for `parseSchema` in the generate
 * pipeline.
 */
export async function fetchSchemas(options?: { force?: boolean }): Promise<Map<string, Buffer>> {
  const raw = await fetchWithCache({ url: SCHEMA_URL, cacheFile: CACHE_FILE }, options?.force);
  const spec = JSON.parse(raw.toString("utf8")) as {
    components?: { schemas?: Record<string, unknown> };
  };
  const schemas = spec.components?.schemas ?? {};
  const out = new Map<string, Buffer>();
  for (const [name, schema] of Object.entries(schemas)) {
    out.set(name, Buffer.from(JSON.stringify(schema)));
  }
  return out;
}
