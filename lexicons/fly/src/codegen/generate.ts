/**
 * Fly generation pipeline — uses core generatePipeline with fly-specific
 * fetch, parse, naming, and generation callbacks.
 */

import {
  generatePipeline,
  writeGeneratedArtifacts,
  type GenerateOptions,
  type GenerateResult,
  type GeneratePipelineConfig,
} from "@intentius/chant/codegen/generate";
import { fetchSchemas } from "../spec/fetch";
import { parseFlyOpenAPI, type FlyParseResult } from "../spec/parse";
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
 * Run the full fly generation pipeline.
 */
export async function generate(opts: GenerateOptions = {}): Promise<GenerateResult> {
  // The flaps spec is a single document — parseFlyOpenAPI returns multiple
  // results. The pipeline calls parseSchema once, so we return the first result
  // and inject the rest via augmentResults.
  let pendingResults: FlyParseResult[] = [];

  const config: GeneratePipelineConfig<FlyParseResult> = {
    fetchSchemas: (fetchOpts) => fetchSchemas({ force: fetchOpts.force }),

    parseSchema: (_typeName, data) => {
      const results = parseFlyOpenAPI(data);
      if (results.length === 0) return null;
      pendingResults = results.slice(1);
      return results[0];
    },

    createNaming: (results) => new NamingStrategy(results),

    augmentResults: (results, _opts, log) => {
      if (pendingResults.length > 0) {
        results.push(...pendingResults);
        log(`Added ${pendingResults.length} additional fly schemas from OpenAPI spec`);
        pendingResults = [];
      }
      log(`Total: ${results.length} fly resource/property schemas`);
      return { results };
    },

    generateRegistry: (results, naming) => generateLexiconJSON(results, naming as NamingStrategy),

    generateTypes: (results, naming) => generateTypeScriptDeclarations(results, naming as NamingStrategy),

    generateRuntimeIndex: (results, naming) => generateRuntimeIndex(results, naming as NamingStrategy),
  };

  return generatePipeline(config, opts);
}

/**
 * Write generated artifacts to disk.
 */
export function writeGeneratedFiles(result: GenerateResult, baseDir: string): void {
  writeGeneratedArtifacts({
    baseDir,
    files: {
      "lexicon-fly.json": result.lexiconJSON,
      "index.d.ts": result.typesDTS,
      "index.ts": result.indexTS,
      "runtime.ts": `/**\n * Runtime factory constructors — re-exported from core.\n */\nexport { createResource, createProperty } from "@intentius/chant/runtime";\n`,
    },
  });
}

/**
 * Generate the runtime index.ts with factory constructor exports.
 */
function generateRuntimeIndex(results: FlyParseResult[], naming: NamingStrategy): string {
  const resourceEntries: RuntimeIndexEntry[] = [];
  const propertyEntries: RuntimeIndexPropertyEntry[] = [];

  for (const r of results) {
    const typeName = r.resource.typeName;
    const tsName = naming.resolve(typeName);
    if (!tsName) continue;

    if (r.isProperty) {
      propertyEntries.push({ tsName, resourceType: typeName });
    } else {
      const attrs: Record<string, string> = {};
      for (const attr of r.resource.attributes) {
        attrs[attr.name] = attr.name;
      }
      resourceEntries.push({ tsName, resourceType: typeName, attrs });
    }
  }

  return coreGenerateRuntimeIndex(resourceEntries, propertyEntries, { lexiconName: "fly" });
}
