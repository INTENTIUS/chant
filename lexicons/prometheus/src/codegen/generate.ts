/**
 * The prometheus lexicon's "generation" step.
 *
 * There is no upstream schema to fetch: Prometheus and Alertmanager define
 * their config files as Go structs and publish no machine-readable schema for
 * them. The types are written by hand against the releases in
 * `PROMETHEUS_PIN` (src/pin.ts), and this step derives the registry from the
 * entity catalog, so the packaged `dist/meta.json` can never disagree with
 * the classes the package exports.
 */

import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { mkdirSync, writeFileSync } from "fs";
import type { GenerateResult } from "@intentius/chant/codegen/generate";
import { CATALOG, lexiconRegistry } from "../catalog";

export type { GenerateResult };

/** The packaged types entry re-exports the compiled declarations, which carry every config type. */
const TYPES_DTS = `// The prometheus lexicon's entity classes and config types are hand-written in
// src/ and compiled to dist/index.d.ts; this entry re-exports them.
export * from "../index";
`;

export async function generate(opts?: { verbose?: boolean; force?: boolean }): Promise<GenerateResult> {
  const registry = lexiconRegistry();
  const lexiconJSON = `${JSON.stringify(registry, null, 2)}\n`;
  if (opts?.verbose) {
    console.error(`prometheus: ${CATALOG.length} entities (RuleGroup and the Alertmanager kinds)`);
  }
  return {
    lexiconJSON,
    typesDTS: TYPES_DTS,
    indexTS: "",
    resources: CATALOG.length,
    properties: 0,
    enums: 0,
    warnings: [],
  };
}

/** Write the registry to src/generated/lexicon-prometheus.json, for tools that read it from there. */
export function writeGeneratedFiles(result: GenerateResult): void {
  const pkgDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  const dir = join(pkgDir, "src", "generated");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "lexicon-prometheus.json"), result.lexiconJSON);
}
