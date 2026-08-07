/**
 * Control Plane Core API OpenAPI 3.0.3 spec.
 *
 * `https://api.cpln.io/openapi.json` is an unversioned live endpoint: it always
 * serves the current spec, and there is no tag, release asset, or `info.version`
 * bump to pin against — `info.version` has read `1.0.0` for as long as the
 * endpoint has existed. There is consequently nothing for the self-upgrade
 * tooling to bump, so this plugin declares no `upstreamPin`, the same call fly
 * makes for `docs.machines.dev/openapi.json`. Re-running `generate` picks up
 * whatever the endpoint currently serves.
 *
 * Unlike fly, this lexicon keeps a committed offline fallback. Two reasons the
 * live-only route was not good enough here:
 *
 * - The endpoint is the production API's own doc route, not a docs CDN. It is
 *   subject to the same maintenance windows as the API, and a generate step
 *   that fails when Control Plane is briefly unreachable makes CI a function of
 *   someone else's uptime.
 * - The full document is 2.8 MB, almost all of which is the `patch_*` mirror
 *   schemas and kinds this lexicon does not model. The snapshot is pruned to
 *   the schemas actually reachable from the modelled kinds — 23 of 106 — which
 *   is small enough to commit, and to re-indent for a readable diff, without
 *   turning every regeneration into a megabyte-scale change.
 *
 * The fallback is never silent. Both routes log which one was taken, because a
 * fallback nobody can see is how you end up debugging types that came from
 * somewhere you did not expect.
 *
 * Refresh the snapshot with `just snapshot` (see `snapshot-cli.ts`).
 */

import { join, dirname } from "path";
import { homedir } from "os";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { fetchWithCache } from "@intentius/chant/codegen/fetch";

export const SCHEMA_URL = "https://api.cpln.io/openapi.json";

/**
 * Cache under `~/.chant` (like fly and k8s) so CI's `~/.chant` schema cache
 * covers it — an api.cpln.io hiccup then falls back to the cache before it
 * falls back to the committed snapshot.
 */
const CACHE_FILE = join(homedir(), ".chant", "cpln-openapi.json");

export const SNAPSHOT_FILE = join(dirname(fileURLToPath(import.meta.url)), "cpln-openapi.snapshot.json");

/** The single map key the parser is handed. The spec is one document. */
export const SPEC_KEY = "Cpln::OpenAPI";

/**
 * Fetch the Control Plane OpenAPI spec, falling back to the committed pruned
 * snapshot when the endpoint is unreachable. Returns a single-entry map — the
 * whole spec is one document; the parser fans it out into per-kind results.
 */
export async function fetchSchemas(options?: { force?: boolean }): Promise<Map<string, Buffer>> {
  let raw: Buffer;
  try {
    raw = await fetchWithCache({ url: SCHEMA_URL, cacheFile: CACHE_FILE }, options?.force);
    // A 404 body is still a body. Parsing proves we got a spec and not an error
    // page that would otherwise be cached and then generated from.
    const parsed = JSON.parse(raw.toString("utf-8")) as { components?: { schemas?: unknown } };
    if (!parsed.components?.schemas) {
      throw new Error("response carried no components.schemas");
    }
    console.error(`[cpln] spec: live ${SCHEMA_URL}`);
  } catch (err) {
    console.error(
      `[cpln] spec: committed snapshot — could not fetch ${SCHEMA_URL} ` +
        `(${err instanceof Error ? err.message.split("\n")[0] : String(err)}). ` +
        `Refresh it with \`just snapshot\` on a networked machine.`,
    );
    raw = readFileSync(SNAPSHOT_FILE);
  }
  return new Map([[SPEC_KEY, raw]]);
}
