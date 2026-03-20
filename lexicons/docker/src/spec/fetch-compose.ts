/**
 * Fetch and cache the Compose Spec JSON Schema.
 */

import { join } from "path";
import { homedir } from "os";
import { fetchWithCache } from "@intentius/chant/codegen/fetch";
import { COMPOSE_SPEC_URL, COMPOSE_SPEC_CACHE } from "../codegen/versions";

export function getCachePath(): string {
  return join(homedir(), ".chant", COMPOSE_SPEC_CACHE);
}

/**
 * Fetch the Compose Spec JSON Schema, with local caching.
 */
export async function fetchComposeSpec(force?: boolean): Promise<Buffer> {
  return fetchWithCache(
    {
      url: COMPOSE_SPEC_URL,
      cacheFile: getCachePath(),
    },
    force,
  );
}

/**
 * Fetch compose spec as a Map keyed by entity type — for generatePipeline.
 */
export async function fetchComposeSchemas(force?: boolean): Promise<Map<string, Buffer>> {
  const data = await fetchComposeSpec(force);
  const schemas = new Map<string, Buffer>();
  schemas.set("Docker::Compose::Service", data);
  return schemas;
}
