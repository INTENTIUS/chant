import { join } from "path";
import { homedir } from "os";
import { fetchWithCache } from "@intentius/chant/codegen/fetch";

/**
 * Fly's published Machines API (flaps) OpenAPI 3.0.1 spec.
 *
 * This is an unversioned live endpoint: it always serves the current spec with
 * no version or release tag to pin. There is nothing for the self-upgrade
 * tooling (#685) to bump, so the plugin declares no `upstreamPin` — unlike gcp
 * (`KCC_VERSION`) or k8s (`K8S_SCHEMA_VERSION`), which pin a released schema
 * version. Re-running `generate` simply picks up whatever this URL currently
 * serves.
 */
const SCHEMA_URL = "https://docs.machines.dev/openapi.json";
/**
 * Cache under `~/.chant` (like the k8s lexicon) so CI's `~/.chant` schema
 * cache covers it — a `docs.machines.dev` hiccup then falls back to the cache
 * instead of failing the generate step.
 */
const CACHE_FILE = join(homedir(), ".chant", "fly-machines-openapi.json");

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
