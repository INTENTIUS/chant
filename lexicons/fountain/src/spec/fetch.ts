/**
 * Fetch the fountain OpenAPI spec.
 *
 * Pinned to a release artifact, not a live endpoint. Upstream ships
 * `openapi.json` as a release asset (BinaryBourbon/fountain#147), so there is
 * a tag to pin and generation is reproducible: same pin in, same generated
 * surface out, on any machine, with or without a network.
 *
 * It used to fetch `/api/openapi.json` from a running instance. That made the
 * generated types a function of whatever a particular server happened to be
 * serving at the moment someone ran `npm run generate` — two runs a week apart
 * could differ with no diff in chant to explain it. Every other lexicon pins
 * its upstream spec (AWS a CloudFormation zip, each k8s CRD an operator
 * release); this one no longer is the exception.
 *
 * The committed snapshot is now only the offline path. It is not a silent
 * substitute for the pin: both routes log which one was taken and at what
 * version, because a fallback nobody can see is how you end up debugging types
 * that came from somewhere you did not expect.
 */

import { join, dirname } from "path";
import { homedir } from "os";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { fetchWithCache } from "@intentius/chant/codegen/fetch";

/**
 * The pinned upstream spec.
 *
 * v0.3.0 is the first release to carry the `openapi.json` asset. Bumping this
 * changes the generated surface, so it belongs in its own commit with the
 * regenerated snapshot beside it.
 */
export const FOUNTAIN_SPEC_VERSION = "v0.3.0";

const SCHEMA_URL = `https://github.com/BinaryBourbon/fountain/releases/download/${FOUNTAIN_SPEC_VERSION}/openapi.json`;

const CACHE_FILE = join(homedir(), ".chant", `fountain-openapi-${FOUNTAIN_SPEC_VERSION}.json`);

const SNAPSHOT_FILE = join(dirname(fileURLToPath(import.meta.url)), "fountain-openapi.snapshot.json");

/**
 * Fetch the pinned fountain OpenAPI spec, falling back to the committed
 * snapshot when there is no network. Returns a single-entry map — the whole
 * spec is one document; the parser fans it out into per-kind results.
 */
export async function fetchSchemas(options?: { force?: boolean }): Promise<Map<string, Buffer>> {
  let raw: Buffer;
  try {
    raw = await fetchWithCache({ url: SCHEMA_URL, cacheFile: CACHE_FILE }, options?.force);
    // A 404 body is still a body. Parsing proves we got a spec and not an
    // error page that would otherwise be cached and generated from.
    JSON.parse(raw.toString("utf-8"));
    console.error(`[fountain] spec: pinned release ${FOUNTAIN_SPEC_VERSION}`);
  } catch (err) {
    console.error(
      `[fountain] spec: committed snapshot — could not fetch pinned release ${FOUNTAIN_SPEC_VERSION} ` +
        `(${err instanceof Error ? err.message.split("\n")[0] : err}). ` +
        `Refresh it with \`npm run generate -- --force\` on a networked machine.`,
    );
    raw = readFileSync(SNAPSHOT_FILE);
  }
  return new Map([["fountain-openapi.json", raw]]);
}
