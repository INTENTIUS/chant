/**
 * Forgejo lexicon "generation" step.
 *
 * Forgejo has no spec of its own — every entity, property type, and enum a
 * forgejo project uses comes from `@intentius/chant-lexicon-github` (see
 * src/index.ts). There is nothing to fetch or parse here; this module exists
 * only so `packagePipeline` (./package.ts) has a `GenerateResult` to build
 * dist/manifest.json from. Refresh github's entities by running `chant
 * generate` in the github lexicon, not here.
 */

import type { GenerateResult } from "@intentius/chant/codegen/generate";

export type { GenerateResult };

// No entities of forgejo's own — the catalog is intentionally empty.
const LEXICON_JSON = "{}";

const TYPES_DTS = `// forgejo has no resource types of its own. Every entity a forgejo
// project imports is declared in @intentius/chant-lexicon-github and
// re-exported from this package's main entry point.
export {};
`;

export async function generate(opts?: { verbose?: boolean; force?: boolean }): Promise<GenerateResult> {
  if (opts?.verbose) {
    console.error("forgejo: no spec of its own — reuses the github lexicon's entities wholesale (0 own resources)");
  }
  return {
    lexiconJSON: LEXICON_JSON,
    typesDTS: TYPES_DTS,
    indexTS: "",
    resources: 0,
    properties: 0,
    enums: 0,
    warnings: [],
  };
}
