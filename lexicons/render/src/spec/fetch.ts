import { join } from "path";
import { homedir } from "os";
import { fetchWithCache } from "@intentius/chant/codegen/fetch";

/**
 * Render's published Public API OpenAPI 3.0 spec.
 *
 * Render serves the current spec at a fixed URL with no version or release tag
 * to pin (the document's own `info.version` has sat at "1.0.0" across many
 * additive changes), so — like fly — the plugin declares no `upstreamPin`.
 * Re-running `generate` picks up whatever the URL currently serves.
 */
export const SCHEMA_URL = "https://api-docs.render.com/v1.0/openapi/render-public-api-1.json";

/**
 * Cache under `~/.chant` so CI's `~/.chant` schema cache covers it — an
 * api-docs.render.com hiccup then falls back to the cache instead of failing
 * the generate step.
 */
const CACHE_FILE = join(homedir(), ".chant", "render-public-api-openapi.json");

/**
 * Fetch the Render OpenAPI spec and return it as a Map<typeName, Buffer>
 * compatible with the generatePipeline fetchSchemas callback.
 *
 * The spec is a single document, so we return a single entry keyed by
 * "Render::OpenAPI" — the parse step splits it into the curated resources and
 * their reachable property types.
 */
export async function fetchSchemas(options?: { force?: boolean }): Promise<Map<string, Buffer>> {
  const raw = await fetchWithCache({ url: SCHEMA_URL, cacheFile: CACHE_FILE }, options?.force);
  return new Map([["Render::OpenAPI", raw]]);
}
