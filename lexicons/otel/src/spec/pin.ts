/**
 * What the otel lexicon's generated config types are pinned to (#3361).
 *
 * ## The version pins
 *
 * Upstream publishes a `config.schema.yaml` next to each component's
 * `config.go`, produced by `schemagen` from the Go structs. A collector
 * *distribution* decides which components a given `otelcol` binary carries, so
 * the types are scoped by a distribution's builder manifest
 * (`distributions/<name>/manifest.yaml` in opentelemetry-collector-releases) at
 * a release tag:
 *
 * - `otelcol-contrib`, the distribution the built-ins are generated against and
 *   the one `COLLECTOR_IMAGE` runs;
 * - `otelcol-k8s`, a second pin, so the coverage report can say which built-ins
 *   the Kubernetes distribution leaves out.
 *
 * Each manifest names the component modules and their versions; the schemas
 * are read from opentelemetry-collector and opentelemetry-collector-contrib at
 * those versions. Every one of these is a git tag, so the content behind a pin
 * never moves.
 *
 * ## The content pin
 *
 * The resolved set (both manifests' component index plus every schema document
 * the built-ins reach through `$ref`) is committed as
 * `otel-schemas.snapshot.json`, and generation reads only that file, offline.
 * The digest below is over that resolved set, so a hand edit to the snapshot,
 * or a refresh nobody accepted, refuses to generate. Moving a version is: bump
 * the constant, run `just snapshot`, read the diff, and paste the printed pin
 * here, in the same commit.
 */

import { createHash } from "crypto";

/** The opentelemetry-collector-releases tag whose `otelcol-contrib` manifest scopes the built-ins. */
export const OTELCOL_CONTRIB_VERSION = "v0.162.0";

/** The opentelemetry-collector-releases tag whose `otelcol-k8s` manifest the coverage report also reads. */
export const OTELCOL_K8S_VERSION = "v0.162.0";

/** Env var that accepts a snapshot whose digest does not match the pin, printing the new pin. */
export const ACCEPT_ENV = "CHANT_ACCEPT_OTEL_SPEC";

export interface OtelSpecPin {
  /** `sha256:…` over the resolved set, see {@link specDigest}. */
  readonly digest: string;
  /** How many schema documents the resolved set holds. */
  readonly documents: number;
  /** ISO date the pin was accepted, so a diff reads as a decision. */
  readonly accepted: string;
}

/** The accepted resolved set. Paste the block `just snapshot` prints here. */
export const OTEL_SPEC_PIN: OtelSpecPin = {
  digest: "sha256:90ac78ed3f40aac1ef29b4df9a11574a829f08de2758c379817a92e557bb9d05",
  documents: 133,
  accepted: "2026-10-24",
};

/**
 * Refuse a snapshot taken at other versions than the constants above: a
 * version bump without `just snapshot` would otherwise generate the old
 * release's types under the new pin.
 */
export function assertSnapshotVersions(versions: { "otelcol-contrib": string; "otelcol-k8s": string }): void {
  const wrong = [
    versions["otelcol-contrib"] !== OTELCOL_CONTRIB_VERSION ? `otelcol-contrib ${versions["otelcol-contrib"]} (pin ${OTELCOL_CONTRIB_VERSION})` : "",
    versions["otelcol-k8s"] !== OTELCOL_K8S_VERSION ? `otelcol-k8s ${versions["otelcol-k8s"]} (pin ${OTELCOL_K8S_VERSION})` : "",
  ].filter(Boolean);
  if (wrong.length > 0) {
    throw new Error(
      `The otel schema snapshot was taken at ${wrong.join(" and ")}. Run \`just snapshot\` in lexicons/otel, ` +
        "paste the printed OTEL_SPEC_PIN into src/spec/pin.ts, and generate again.",
    );
  }
}

/** Stable JSON: object keys sorted at every level, so the digest ignores key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .filter((k) => obj[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The parts of a snapshot the digest covers. */
export interface DigestInput {
  readonly versions: unknown;
  readonly distributions: unknown;
  readonly schemas: Readonly<Record<string, unknown>>;
}

/**
 * Digest the resolved set: the versions, the distribution index, and each
 * schema document by key, in key order.
 */
export function specDigest(input: DigestInput): string {
  const hash = createHash("sha256");
  hash.update(canonicalJson(input.versions));
  hash.update(canonicalJson(input.distributions));
  for (const key of Object.keys(input.schemas).sort()) {
    hash.update(key);
    hash.update(createHash("sha256").update(canonicalJson(input.schemas[key])).digest());
  }
  return `sha256:${hash.digest("hex")}`;
}

/** The pin block to paste into this file for a resolved set. */
export function pinBlock(digest: string, documents: number, accepted = new Date().toISOString().slice(0, 10)): string {
  return [
    "export const OTEL_SPEC_PIN: OtelSpecPin = {",
    `  digest: "${digest}",`,
    `  documents: ${documents},`,
    `  accepted: "${accepted}",`,
    "};",
  ].join("\n");
}

/**
 * Refuse a snapshot whose digest does not match the pin. Under
 * {@link ACCEPT_ENV} it warns with the block to paste instead.
 */
export function assertPinnedSnapshot(
  input: DigestInput,
  options: { pin?: OtelSpecPin; env?: NodeJS.ProcessEnv; warn?: (message: string) => void } = {},
): void {
  const pin = options.pin ?? OTEL_SPEC_PIN;
  const digest = specDigest(input);
  if (digest === pin.digest) return;
  const documents = Object.keys(input.schemas).length;
  const message = [
    "The otel schema snapshot (src/spec/otel-schemas.snapshot.json) does not match OTEL_SPEC_PIN.",
    "",
    `  pinned    ${pin.digest}  (${pin.documents} documents, accepted ${pin.accepted})`,
    `  snapshot  ${digest}  (${documents} documents)`,
    "",
    "If the snapshot was refreshed on purpose (`just snapshot`), read its diff and",
    "paste this into lexicons/otel/src/spec/pin.ts in the same commit:",
    "",
    pinBlock(digest, documents),
  ].join("\n");
  const env = options.env ?? process.env;
  if (env[ACCEPT_ENV]) {
    (options.warn ?? ((m: string) => console.error(m)))(message);
    return;
  }
  throw new Error(`${message}\n\nOr re-run with ${ACCEPT_ENV}=1 to generate from it this once.`);
}
