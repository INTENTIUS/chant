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
 * that came from somewhere you did not expect. And it is refused outright when
 * its own `info.version` is not the pin (#2389). A bump that changes the
 * constant but not the snapshot would otherwise generate the old surface on
 * any machine without a network and label it with the new version.
 */

import { join, dirname } from "path";
import { homedir } from "os";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { fetchWithCache } from "@intentius/chant/codegen/fetch";

/**
 * The pinned upstream spec.
 *
 * v0.3.0 was the first release to carry the `openapi.json` asset. v0.16.0 is
 * the first that describes team, schedules, webhooks, sandboxes and the event
 * stream, which is what the Teammate, Schedule and Webhook kinds are generated
 * from. v0.21.0 adds `setup_timeout_seconds` to Environment and describes the
 * acp runtime itself (`runtime: "acp"` and `runtime_command` on Agent, with
 * `model` no longer required), which chant had modeled as an extension until
 * then. Bumping this changes the generated surface, so it belongs in its own
 * commit with the regenerated snapshot beside it.
 */
export const FOUNTAIN_SPEC_VERSION = "v0.21.0";

// The repository moved from BinaryBourbon to managoat. The old path still
// answers with a redirect, but a pin should not depend on one (#2389).
const SCHEMA_URL = `https://github.com/managoat/fountain/releases/download/${FOUNTAIN_SPEC_VERSION}/openapi.json`;

const CACHE_FILE = join(homedir(), ".chant", `fountain-openapi-${FOUNTAIN_SPEC_VERSION}.json`);

const SNAPSHOT_FILE = join(dirname(fileURLToPath(import.meta.url)), "fountain-openapi.snapshot.json");

/**
 * Fetch the pinned fountain OpenAPI spec, falling back to the committed
 * snapshot when there is no network. Returns a single-entry map — the whole
 * spec is one document; the parser fans it out into per-kind results.
 */
export async function fetchSchemas(options?: {
  force?: boolean;
  /** The offline fallback's file. Tests point it at a snapshot of another release. */
  snapshotFile?: string;
}): Promise<Map<string, Buffer>> {
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
    raw = readSnapshot(options?.snapshotFile ?? SNAPSHOT_FILE);
  }
  return new Map([["fountain-openapi.json", raw]]);
}

/**
 * Read the committed snapshot, refusing it when it describes a release other
 * than the pinned one. The spec's `info.version` carries no leading `v`
 * (`0.21.0`) where the release tag does (`v0.21.0`), so both are compared
 * without it.
 */
export function readSnapshot(file: string = SNAPSHOT_FILE, pinned: string = FOUNTAIN_SPEC_VERSION): Buffer {
  const raw = readFileSync(file);
  let version: unknown;
  try {
    version = (JSON.parse(raw.toString("utf-8")) as { info?: { version?: unknown } }).info?.version;
  } catch (err) {
    throw new Error(
      `[fountain] spec: the committed snapshot at ${file} is not JSON ` +
        `(${err instanceof Error ? err.message.split("\n")[0] : err}), so the pinned release ${pinned} cannot be read from it.`,
    );
  }
  const bare = (v: string) => v.replace(/^v/, "");
  if (typeof version !== "string" || bare(version) !== bare(pinned)) {
    throw new Error(
      `[fountain] spec: the committed snapshot is fountain ${typeof version === "string" ? version : "(no info.version)"}, ` +
        `but the pin is ${pinned}. Generating from it would label one release's surface with another's version. ` +
        `Refresh the snapshot from the ${pinned} release asset on a networked machine.`,
    );
  }
  return raw;
}
