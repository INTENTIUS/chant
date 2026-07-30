/**
 * Fetch the fountain OpenAPI spec.
 *
 * Fountain serves its OpenAPI 3.1 spec from the running app at
 * /api/openapi.json (generated from code via OpenApiSpex; public, no auth).
 * This is an unversioned live endpoint: it always serves the spec of
 * whatever is currently deployed, with no release tag to pin — fountain
 * follows the rolling-spec model (like fly). A versioned spec artifact per
 * release shipped upstream as a release asset (BinaryBourbon/fountain#140);
 * when the hosted endpoint is reliably current this fetcher can prefer it.
 *
 * Fallback: a committed snapshot (fountain-openapi.snapshot.json) keeps
 * generation hermetic when the live endpoint is unreachable — CI runs,
 * offline dev, or the current state where the hosted instance predates the
 * endpoint. The snapshot is refreshed alongside surface.snapshot.json when
 * upstream moves (regenerate from a fountain checkout via
 * `mix openapi.spec.json --spec FountainWeb.ApiSpec`).
 */

import { join, dirname } from "path";
import { homedir } from "os";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { fetchWithCache } from "@intentius/chant/codegen/fetch";

const SCHEMA_URL = "https://founta.inevitable.fyi/api/openapi.json";

const CACHE_FILE = join(homedir(), ".chant", "fountain-openapi.json");

const SNAPSHOT_FILE = join(dirname(fileURLToPath(import.meta.url)), "fountain-openapi.snapshot.json");

/**
 * Fetch the fountain OpenAPI spec with caching, falling back to the
 * committed snapshot when the live endpoint is unreachable. Returns a
 * single-entry map — the whole spec is one document; the parser fans it
 * out into per-kind results.
 */
export async function fetchSchemas(options?: { force?: boolean }): Promise<Map<string, Buffer>> {
  let raw: Buffer;
  try {
    raw = await fetchWithCache({ url: SCHEMA_URL, cacheFile: CACHE_FILE }, options?.force);
    // The live host currently 404s (deploy lag) — a non-spec body must not
    // silently replace the snapshot.
    JSON.parse(raw.toString("utf-8"));
  } catch (err) {
    console.error(
      `[fountain] live spec fetch failed (${err instanceof Error ? err.message.split("\n")[0] : err}) — ` +
        `using committed snapshot`,
    );
    raw = readFileSync(SNAPSHOT_FILE);
  }
  return new Map([["fountain-openapi.json", raw]]);
}
