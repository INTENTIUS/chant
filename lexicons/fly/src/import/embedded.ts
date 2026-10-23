/**
 * Where a Fly Machine embeds another lexicon's content, for `chant import`
 * (#3373).
 *
 * A machine's `config.files[]` entry with a `raw_value` is a file written into
 * the machine, base64 in flaps. The parser decodes each one and offers the text
 * to core's embedded-content resolver, as k8s offers a ConfigMap value
 * (#2962). `FlyOtelCollector` writes its collector config this way, at the otel
 * lexicon's `COLLECTOR_CONFIG_PATH`, so a live or file import of that machine
 * gives the same otel source `chant import config.yaml` gives.
 *
 * Which lexicon imports the content is decided by core at run time; the hint
 * below only names the owner a warning suggests when none is installed.
 */

import type { EmbeddedContent, EmbeddedContentResolver, EmbeddedReference } from "@intentius/chant/import/embedded";
import { embeddedDocument } from "@intentius/chant/import/embedded";
import { COLLECTOR_CONFIG_PATH } from "@intentius/chant-lexicon-otel";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The UTF-8 text a base64 `raw_value` holds, or undefined when it is not base64 of text. */
export function decodeRawValue(raw: string): string | undefined {
  if (!/^[A-Za-z0-9+/\s]*={0,2}\s*$/.test(raw)) return undefined;
  const bytes = Buffer.from(raw, "base64");
  const text = bytes.toString("utf8");
  // A round trip that changes the bytes means the file is not UTF-8 text.
  return Buffer.from(text, "utf8").equals(bytes) ? text : undefined;
}

function hintFor(guestPath: string, doc: unknown): EmbeddedContent["expectedOwner"] {
  if (guestPath === COLLECTOR_CONFIG_PATH) return { lexicon: "otel", what: "an OpenTelemetry Collector config" };
  if (isRecord(doc) && isRecord(doc.service) && isRecord(doc.service.pipelines)) {
    return { lexicon: "otel", what: "an OpenTelemetry Collector config" };
  }
  return undefined;
}

/**
 * The marker the parser leaves on a file whose `raw_value` an owner imports:
 * the generator renders it as the base64 of the reference's text.
 */
export interface EmbeddedRawValue {
  readonly $base64: EmbeddedReference;
}

export function isEmbeddedRawValue(v: unknown): v is EmbeddedRawValue {
  return isRecord(v) && isRecord(v.$base64);
}

/**
 * Offer each `config.files[].raw_value` of one machine to `embedded`, replacing
 * the value an owner imports with an {@link EmbeddedRawValue}. `properties` is
 * the machine's IR properties, changed in place with fresh copies on the way
 * down.
 */
export function delegateEmbedded(
  machineName: string,
  properties: Record<string, unknown>,
  embedded: EmbeddedContentResolver,
): void {
  const config = properties.config;
  if (!isRecord(config) || !Array.isArray(config.files)) return;
  const files = config.files;
  let changed = false;
  const next = files.map((file, i) => {
    if (!isRecord(file) || typeof file.raw_value !== "string") return file;
    const text = decodeRawValue(file.raw_value);
    if (text === undefined) return file;
    const doc = embeddedDocument(text);
    if (!isRecord(doc)) return file;
    const guestPath = typeof file.guest_path === "string" ? file.guest_path : `files[${i}]`;
    const base = guestPath.split("/").pop()!.replace(/\.[^.]*$/, "");
    const ref = embedded.resolve({
      host: "fly",
      hostType: "Fly::Machines::Machine",
      location: `Machine ${machineName} file ${guestPath}`,
      directory: files.length === 1 ? machineName : `${machineName}-${base}`,
      text,
      document: doc,
      expectedOwner: hintFor(guestPath, doc),
    });
    if (!ref) return file;
    changed = true;
    return { ...file, raw_value: { $base64: ref } satisfies EmbeddedRawValue };
  });
  if (changed) properties.config = { ...config, files: next };
}
