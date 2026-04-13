/**
 * Temporal lexicon generation step.
 *
 * All 4 resources (TemporalServer, TemporalNamespace, SearchAttribute, TemporalSchedule)
 * are hand-written. There is no remote spec to fetch or parse. This module builds
 * the required lexiconJSON catalog and typesDTS stubs so that packagePipeline
 * can hash and write dist/ artifacts correctly.
 */

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import type { GenerateResult } from "@intentius/chant/codegen/generate";

export type { GenerateResult };

// ── Lexicon catalog (meta.json) ──────────────────────────────────────
// Describes the 4 hand-written resources so tooling (LSP, MCP, docs) can
// enumerate them without parsing the TypeScript source at runtime.

const LEXICON_JSON = JSON.stringify(
  {
    TemporalServer: {
      resourceType: "Temporal::Server",
      kind: "resource",
      lexicon: "temporal",
      description: "Temporal server deployment — emits docker-compose.yml and Helm values",
    },
    TemporalNamespace: {
      resourceType: "Temporal::Namespace",
      kind: "resource",
      lexicon: "temporal",
      description: "Temporal namespace — emits namespace create command in temporal-setup.sh",
    },
    SearchAttribute: {
      resourceType: "Temporal::SearchAttribute",
      kind: "resource",
      lexicon: "temporal",
      description: "Temporal search attribute — emits search-attribute create command in temporal-setup.sh",
    },
    TemporalSchedule: {
      resourceType: "Temporal::Schedule",
      kind: "resource",
      lexicon: "temporal",
      description: "Temporal schedule — emits SDK schedule creation TypeScript to schedules/<id>.ts",
    },
  },
  null,
  2,
);

// ── Type declarations stub (types/index.d.ts) ────────────────────────
// All types are declared in src/resources.ts and re-exported from src/index.ts.
// The dist/types/index.d.ts file is a stub that satisfies the BundleSpec shape.

const TYPES_DTS = `// Types for @intentius/chant-lexicon-temporal are declared in src/resources.ts.
// They are available via the package's main export: import { ... } from "@intentius/chant-lexicon-temporal";
export {};
`;

// ── Generate ─────────────────────────────────────────────────────────

export async function generate(opts?: { verbose?: boolean; force?: boolean }): Promise<GenerateResult> {
  if (opts?.verbose) {
    console.error("temporal: all resources are hand-written — building catalog from static definitions");
  }
  return {
    lexiconJSON: LEXICON_JSON,
    typesDTS: TYPES_DTS,
    indexTS: "",
    resources: 4,
    properties: 0,
    enums: 0,
    warnings: [],
  };
}

export function writeGeneratedFiles(_result: GenerateResult, pkgDir: string): void {
  // Write the catalog to src/generated/ so createCatalogResource can locate it at runtime.
  const generatedDir = join(pkgDir, "src", "generated");
  mkdirSync(generatedDir, { recursive: true });
  writeFileSync(join(generatedDir, "lexicon-temporal.json"), LEXICON_JSON, "utf-8");
}
