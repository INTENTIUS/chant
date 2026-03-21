/**
 * Slurm generation pipeline — fetches the inline Slurm 23.11 REST API spec,
 * parses it, and emits lexicon-slurm.json + index.d.ts + index.ts.
 */

import {
  generatePipeline,
  writeGeneratedArtifacts,
  type GenerateOptions,
  type GenerateResult,
} from "@intentius/chant/codegen/generate";
import {
  generateRuntimeIndex,
  type RuntimeIndexEntry,
  type RuntimeIndexPropertyEntry,
} from "@intentius/chant/codegen/generate-runtime-index";
import { fetchSchemas } from "../spec/fetch";
import { parseSlurmSchema, type SlurmParseResult } from "../spec/parse";
import { NamingStrategy } from "./naming";
import { generateLexiconJSON } from "./generate-lexicon";
import { generateTypeScriptDeclarations } from "./generate-typescript";
import { dirname } from "path";
import { fileURLToPath } from "url";

export type { GenerateOptions, GenerateResult };

const slurmPipelineConfig = {
  fetchSchemas: async (opts: { force?: boolean }) => fetchSchemas(opts),

  parseSchema: (typeName: string, data: Buffer): SlurmParseResult | null => {
    try {
      return parseSlurmSchema(typeName, data);
    } catch {
      return null;
    }
  },

  createNaming: (results: SlurmParseResult[]) => new NamingStrategy(results),

  generateRegistry: (results: SlurmParseResult[], naming: NamingStrategy) =>
    generateLexiconJSON(results, naming),

  generateTypes: (results: SlurmParseResult[], naming: NamingStrategy) =>
    generateTypeScriptDeclarations(results, naming),

  generateRuntimeIndex: (results: SlurmParseResult[], naming: NamingStrategy): string => {
    const resourceEntries: RuntimeIndexEntry[] = [];
    const propertyEntries: RuntimeIndexPropertyEntry[] = [];

    for (const r of results) {
      const tsName = naming.resolve(r.resource.typeName);
      if (!tsName) continue;
      resourceEntries.push({ tsName, resourceType: r.resource.typeName, attrs: {} });
    }

    return generateRuntimeIndex(resourceEntries, propertyEntries, {
      lexiconName: "slurm",
    });
  },
};

/**
 * Run the full Slurm generation pipeline.
 */
export async function generate(opts: GenerateOptions = {}): Promise<GenerateResult> {
  return generatePipeline(slurmPipelineConfig, opts);
}

/**
 * Write generated artifacts to the package src/generated/ directory.
 */
export function writeGeneratedFiles(result: GenerateResult, pkgDir?: string): void {
  const dir = pkgDir ?? dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  writeGeneratedArtifacts({
    baseDir: dir,
    files: {
      "lexicon-slurm.json": result.lexiconJSON,
      "index.d.ts": result.typesDTS,
      "index.ts": result.indexTS,
      "runtime.ts": [
        "/**",
        " * Runtime factory constructors — re-exported from core.",
        " */",
        'export { createResource, createProperty } from "@intentius/chant/runtime";',
        "",
      ].join("\n"),
    },
  });
}
