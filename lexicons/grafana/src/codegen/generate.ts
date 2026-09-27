/**
 * The grafana lexicon's generate step, offline and deterministic.
 *
 * 1. `src/schema/<name>.gen.ts` from each vendored schema in `src/spec/schemas/`
 *    (see `src/pin.ts`). These are committed, and a test fails when they
 *    drift from what this step would write.
 * 2. `src/generated/lexicon-grafana.json`, the registry of entity classes
 *    the package exports, derived from the catalog so the packaged
 *    `dist/meta.json` cannot disagree with the classes.
 */

import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { mkdirSync, writeFileSync } from "fs";
import type { GenerateResult } from "@intentius/chant/codegen/generate";
import { SCHEMA_NAMES, type SchemaName } from "../pin";
import { digestMismatches, loadSchema } from "../spec/schemas";
import { schemaModule } from "./schema-types";

export type { GenerateResult };

const pkgDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** The dashboard schema's own default `schemaVersion`, the one the serializer emits. */
function dashboardExtras(schema: Record<string, unknown>): string[] {
  const defs = schema.definitions as Record<string, { properties?: Record<string, { default?: unknown }> }>;
  const v = defs.Dashboard?.properties?.schemaVersion?.default;
  if (typeof v !== "number") throw new Error("grafana: dashboard schema has no default schemaVersion");
  return ["/** The dashboard `schemaVersion` the pinned schema defaults to, and the one chant emits. */", `export const DASHBOARD_SCHEMA_VERSION = ${v};`];
}

/** Every generated schema module, keyed by path relative to the package root. */
export function schemaModules(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of SCHEMA_NAMES) {
    const schema = loadSchema(name as SchemaName);
    const extra = name === "dashboard" ? dashboardExtras(schema) : [];
    out[`src/schema/${name}.gen.ts`] = schemaModule(name, schema, extra).source;
  }
  return out;
}

/** The packaged types entry re-exports the compiled declarations. */
const TYPES_DTS = `// The grafana lexicon's entity classes are hand-written in src/, with panel
// and query types generated into src/schema/; this entry re-exports them.
export * from "../index";
`;

export async function generate(opts?: { verbose?: boolean; force?: boolean }): Promise<GenerateResult> {
  const bad = digestMismatches();
  if (bad.length > 0) {
    throw new Error(
      `grafana: vendored schemas do not match GRAFANA_SCHEMA_PIN: ${bad.map((b) => `${b.name} (${b.actual.slice(0, 12)}…)`).join(", ")}. ` +
        "Run `just fetch-schemas` and update src/pin.ts.",
    );
  }
  const modules = schemaModules();
  for (const [rel, source] of Object.entries(modules)) {
    mkdirSync(dirname(join(pkgDir, rel)), { recursive: true });
    writeFileSync(join(pkgDir, rel), source);
  }
  const { BUILTIN_CATALOG, lexiconRegistry } = await import("../catalog");
  const lexiconJSON = `${JSON.stringify(lexiconRegistry(), null, 2)}\n`;
  if (opts?.verbose) {
    console.error(`grafana: ${Object.keys(modules).length} schema modules, ${BUILTIN_CATALOG.length} entity classes`);
  }
  return {
    lexiconJSON,
    typesDTS: TYPES_DTS,
    indexTS: "",
    resources: BUILTIN_CATALOG.length,
    properties: 0,
    enums: 0,
    warnings: [],
  };
}

/** Write the registry to src/generated/lexicon-grafana.json, for tools that read it from there. */
export function writeGeneratedFiles(result: GenerateResult): void {
  const dir = join(pkgDir, "src", "generated");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "lexicon-grafana.json"), result.lexiconJSON);
}
