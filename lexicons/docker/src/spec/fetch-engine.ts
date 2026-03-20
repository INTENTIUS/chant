/**
 * Fetch and cache the Docker Engine API OpenAPI spec.
 */

import { join } from "path";
import { homedir } from "os";
import { fetchWithCache } from "@intentius/chant/codegen/fetch";
import { ENGINE_API_URL, ENGINE_API_CACHE } from "../codegen/versions";

export function getCachePath(): string {
  return join(homedir(), ".chant", ENGINE_API_CACHE);
}

/**
 * Fetch the Docker Engine API swagger YAML, with local caching.
 */
export async function fetchEngineApi(force?: boolean): Promise<Buffer> {
  return fetchWithCache(
    {
      url: ENGINE_API_URL,
      cacheFile: getCachePath(),
    },
    force,
  );
}
