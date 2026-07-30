/**
 * Fetch the fountain OpenAPI spec.
 *
 * Fountain serves its OpenAPI 3.1 spec from the running app at
 * /api/openapi.json (generated from code via OpenApiSpex; public, no auth).
 * This is an unversioned live endpoint: it always serves the spec of
 * whatever is currently deployed, with no release tag to pin. There is
 * nothing for the self-upgrade machinery to bump here — fountain follows
 * the rolling-spec model (like fly), diffing the generated API surface
 * against the committed baseline. A versioned spec artifact per release
 * is proposed upstream (BinaryBourbon/fountain#140); when that lands this
 * fetcher can pin a release instead.
 */

import { join } from "path";
import { homedir } from "os";
import { fetchWithCache } from "@intentius/chant/codegen/fetch";

const SCHEMA_URL = "https://founta.inevitable.fyi/api/openapi.json";

const CACHE_FILE = join(homedir(), ".chant", "fountain-openapi.json");

/**
 * Fetch the fountain OpenAPI spec with caching. Returns a single-entry map —
 * the whole spec is one document; the parser fans it out into per-kind results.
 */
export async function fetchSchemas(options?: { force?: boolean }): Promise<Map<string, Buffer>> {
  const raw = await fetchWithCache({ url: SCHEMA_URL, cacheFile: CACHE_FILE }, options?.force);
  return new Map([["fountain-openapi.json", raw]]);
}
