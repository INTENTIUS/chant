/**
 * The otel lexicon's "generation" step.
 *
 * There is no upstream schema to fetch: the collector defines each
 * component's config as a Go struct, and publishes no machine-readable schema
 * for the set as a whole. The built-in types are written by hand against the
 * collector release named in `COLLECTOR_PIN` (src/define.ts), and this step
 * derives the registry from them, so the packaged `dist/meta.json` can never
 * disagree with the classes the package exports.
 */

import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { mkdirSync, writeFileSync } from "fs";
import type { GenerateResult } from "@intentius/chant/codegen/generate";
import { BUILTIN_CATALOG, lexiconRegistry } from "../catalog";

export type { GenerateResult };

/** The packaged types entry re-exports the compiled declarations, which carry every config type. */
const TYPES_DTS = `// The otel lexicon's entity classes and config types are hand-written in
// src/ and compiled to dist/index.d.ts; this entry re-exports them.
export * from "../index";
`;

export async function generate(opts?: { verbose?: boolean; force?: boolean }): Promise<GenerateResult> {
  const registry = lexiconRegistry();
  const lexiconJSON = `${JSON.stringify(registry, null, 2)}\n`;
  const components = BUILTIN_CATALOG.filter((c) => c.type !== undefined).length;
  if (opts?.verbose) {
    console.error(`otel: ${components} built-in components, plus Pipeline and Service (${BUILTIN_CATALOG.length} entities)`);
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

/** Write the registry to src/generated/lexicon-otel.json, for tools that read it from there. */
export function writeGeneratedFiles(result: GenerateResult): void {
  const pkgDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  const dir = join(pkgDir, "src", "generated");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "lexicon-otel.json"), result.lexiconJSON);
}
