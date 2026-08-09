/**
 * k3s generation pipeline — uses core generatePipeline with k3s-specific
 * fetch, parse, naming, and generation callbacks.
 */

import {
  generatePipeline,
  writeGeneratedArtifacts,
  type GenerateOptions,
  type GenerateResult,
  type GeneratePipelineConfig,
} from "@intentius/chant/codegen/generate";
import { dirname } from "path";
import { fileURLToPath } from "url";
import { fetchSchemas } from "../spec/fetch";
import { parseSpecFiles, type K3sParseResult } from "./parse";
import { NamingStrategy } from "./naming";
import { generateLexiconJSON } from "./generate-lexicon";
import { generateTypeScriptDeclarations } from "./generate-typescript";
import {
  generateRuntimeIndex as coreGenerateRuntimeIndex,
  type RuntimeIndexEntry,
  type RuntimeIndexPropertyEntry,
} from "@intentius/chant/codegen/generate-runtime-index";

export type { GenerateResult };

/**
 * Run the full k3s generation pipeline.
 */
export async function generate(opts: GenerateOptions = {}): Promise<GenerateResult> {
  let pendingResults: K3sParseResult[] = [];

  const config: GeneratePipelineConfig<K3sParseResult> = {
    fetchSchemas: async (fetchOpts) => {
      return fetchSchemas(fetchOpts.force);
    },

    parseSchema: (_typeName, data) => {
      const results = parseSpecFiles(data);
      if (results.length === 0) return null;
      pendingResults = results.slice(1);
      return results[0];
    },

    createNaming: (results) => new NamingStrategy(results),

    augmentResults: (results, _opts, log) => {
      if (pendingResults.length > 0) {
        results.push(...pendingResults);
        log(`Added ${pendingResults.length} additional entities from single spec`);
        pendingResults = [];
      }
      for (const r of results) {
        for (const w of r.warnings ?? []) log(`warning: ${w}`);
      }
      const props = results.map((r) => `${r.resource.typeName}(${r.resource.properties.length})`);
      log(`Total: ${results.length} k3s entities — ${props.join(", ")}`);
      return { results };
    },

    generateRegistry: (results, naming) => {
      return generateLexiconJSON(results, naming as NamingStrategy);
    },

    generateTypes: (results, naming) => {
      return generateTypeScriptDeclarations(results, naming as NamingStrategy);
    },

    generateRuntimeIndex: (results, naming) => {
      return generateRuntimeIndex(results, naming as NamingStrategy);
    },
  };

  return generatePipeline(config, opts);
}

/**
 * Write generated artifacts to disk.
 */
export function writeGeneratedFiles(result: GenerateResult, pkgDir?: string): void {
  const baseDir = pkgDir ?? dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  writeGeneratedArtifacts({
    baseDir,
    files: {
      "lexicon-k3s.json": result.lexiconJSON,
      "index.d.ts": result.typesDTS,
      "index.ts": result.indexTS,
      "runtime.ts": `/**\n * Runtime factory constructors — re-exported from core.\n */\nexport { createResource, createProperty } from "@intentius/chant/runtime";\n`,
    },
  });
}

/**
 * Generate the runtime index.ts with factory constructor exports.
 */
function generateRuntimeIndex(results: K3sParseResult[], naming: NamingStrategy): string {
  const resourceEntries: RuntimeIndexEntry[] = [];
  const propertyEntries: RuntimeIndexPropertyEntry[] = [];

  for (const r of results) {
    const typeName = r.resource.typeName;
    const tsName = naming.resolve(typeName);
    if (!tsName) continue;

    if (r.isProperty) {
      propertyEntries.push({ tsName, resourceType: typeName });
    } else {
      resourceEntries.push({ tsName, resourceType: typeName, attrs: {} });
    }
  }

  return coreGenerateRuntimeIndex(resourceEntries, propertyEntries, {
    lexiconName: "k3s",
  });
}
