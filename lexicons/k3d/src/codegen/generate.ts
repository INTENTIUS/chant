/**
 * k3d generation pipeline — uses core generatePipeline with k3d-specific
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
import { parseConfigSchema, k3dShortName, type K3dParseResult } from "./parse";
import { NamingStrategy, propertyTypeName, extractDefName } from "./naming";
import { generateLexiconJSON } from "./generate-lexicon";
import { generateTypeScriptDeclarations } from "./generate-typescript";
import {
  generateRuntimeIndex as coreGenerateRuntimeIndex,
  type RuntimeIndexEntry,
  type RuntimeIndexPropertyEntry,
} from "@intentius/chant/codegen/generate-runtime-index";

export type { GenerateResult };

/**
 * Run the full k3d generation pipeline.
 */
export async function generate(opts: GenerateOptions = {}): Promise<GenerateResult> {
  let pendingResults: K3dParseResult[] = [];

  const config: GeneratePipelineConfig<K3dParseResult> = {
    fetchSchemas: async (fetchOpts) => {
      return fetchSchemas(fetchOpts.force);
    },

    parseSchema: (_typeName, data) => {
      const results = parseConfigSchema(data);
      if (results.length === 0) return null;
      pendingResults = results.slice(1);
      return results[0];
    },

    createNaming: (results) => new NamingStrategy(results),

    augmentResults: (results, _opts, log) => {
      if (pendingResults.length > 0) {
        results.push(...pendingResults);
        log(`Added ${pendingResults.length} additional entities from single schema`);
        pendingResults = [];
      }
      log(`Total: ${results.length} k3d entity schemas`);
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
      "lexicon-k3d.json": result.lexiconJSON,
      "index.d.ts": result.typesDTS,
      "index.ts": result.indexTS,
      "runtime.ts": `/**\n * Runtime factory constructors — re-exported from core.\n */\nexport { createResource, createProperty } from "@intentius/chant/runtime";\n`,
    },
  });
}

/**
 * Generate the runtime index.ts with factory constructor exports.
 */
function generateRuntimeIndex(
  results: K3dParseResult[],
  naming: NamingStrategy,
): string {
  const resourceEntries: RuntimeIndexEntry[] = [];
  const propertyEntries: RuntimeIndexPropertyEntry[] = [];

  for (const r of results) {
    const typeName = r.resource.typeName;
    const tsName = naming.resolve(typeName);
    if (!tsName) continue;

    const attrs: Record<string, string> = {};

    if (r.isProperty) {
      propertyEntries.push({ tsName, resourceType: typeName });
      for (const alias of naming.aliases(typeName)) {
        propertyEntries.push({ tsName: alias, resourceType: typeName });
      }
    } else {
      resourceEntries.push({ tsName, resourceType: typeName, attrs });
      for (const alias of naming.aliases(typeName)) {
        resourceEntries.push({ tsName: alias, resourceType: typeName, attrs });
      }
    }

    const shortName = k3dShortName(typeName);
    const ptAliases = naming.propertyTypeAliases(typeName);
    for (const pt of r.propertyTypes) {
      const defName = extractDefName(pt.name, shortName);
      const ptName = propertyTypeName(tsName, defName);
      const ptType = `${typeName}.${pt.defType}`;
      propertyEntries.push({ tsName: ptName, resourceType: ptType });

      if (ptAliases) {
        const aliasName = ptAliases.get(defName);
        if (aliasName) {
          propertyEntries.push({ tsName: aliasName, resourceType: ptType });
        }
      }
    }
  }

  return coreGenerateRuntimeIndex(resourceEntries, propertyEntries, {
    lexiconName: "k3d",
  });
}
