/**
 * Read the vendored Grafana schemas (`src/spec/schemas/*.jsonschema.json`) and check
 * them against the digests in `GRAFANA_SCHEMA_PIN`.
 */

import { createHash } from "crypto";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { GRAFANA_SCHEMA_PIN, SCHEMA_NAMES, type SchemaName } from "../pin";

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

const parsed = new Map<SchemaName, Record<string, unknown>>();

/** One vendored schema, parsed (cached per process). */
export function loadSchema(name: SchemaName): Record<string, unknown> {
  let schema = parsed.get(name);
  if (!schema) {
    schema = JSON.parse(readSchemaText(name)) as Record<string, unknown>;
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
