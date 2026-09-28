/**
 * Read the vendored Grafana schemas (`src/spec/schemas/*.jsonschema.json`), check
 * them against the digests in `GRAFANA_SCHEMA_PIN`, and apply the correction
 * overlay (`src/spec/overlay/`, see `./overlay.ts`) on top.
 */

import { createHash } from "crypto";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { GRAFANA_SCHEMA_PIN, SCHEMA_NAMES, type SchemaName } from "../pin";
import { applyOverlay, loadOverlay } from "./overlay";

/**
 * Where the vendored files live: beside this module, under `src/`, so they
 * ship with the source the package runs from and GRAF107 can read them.
 * A function, not a module-scope constant, so edge bundles that import the
 * lexicon never evaluate a filesystem path at load.
 */
export function schemasDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "schemas");
}

export function schemaPath(name: SchemaName): string {
  return join(schemasDir(), `${name}.jsonschema.json`);
}

export function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The raw bytes of one vendored schema. */
export function readSchemaText(name: SchemaName): string {
  return readFileSync(schemaPath(name), "utf-8");
}

/** One vendored schema exactly as pinned, parsed, without the overlay. */
export function loadVendoredSchema(name: SchemaName): Record<string, unknown> {
  return JSON.parse(readSchemaText(name)) as Record<string, unknown>;
}

const parsed = new Map<SchemaName, Record<string, unknown>>();

/**
 * One schema as the lexicon uses it: the vendored file with its overlay
 * applied (cached per process). Types, GRAF107 and validation all read this.
 */
export function loadSchema(name: SchemaName): Record<string, unknown> {
  let schema = parsed.get(name);
  if (!schema) {
    const vendored = loadVendoredSchema(name);
    const overlay = loadOverlay(name);
    schema = overlay ? applyOverlay(vendored, overlay) : vendored;
    parsed.set(name, schema);
  }
  return schema;
}

/** Vendored files whose digest does not match the pin, with what was found. */
export function digestMismatches(): Array<{ name: SchemaName; expected: string; actual: string }> {
  const out: Array<{ name: SchemaName; expected: string; actual: string }> = [];
  for (const name of SCHEMA_NAMES) {
    const actual = sha256(readFileSync(schemaPath(name)));
    const expected = GRAFANA_SCHEMA_PIN.files[name];
    if (actual !== expected) out.push({ name, expected, actual });
  }
  return out;
}
