/**
 * Azure ARM generation pipeline — uses core generatePipeline
 * with Azure-specific fetch, parse, naming, and generation callbacks.
 */

import {
  generatePipeline,
  writeGeneratedArtifacts,
  type GenerateOptions,
  type GenerateResult,
  type GeneratePipelineConfig,
} from "@intentius/chant/codegen/generate";
import { fetchArmSchemas } from "../spec/fetch";
import { parseArmSchema, armShortName, type ArmSchemaParseResult } from "../spec/parse";
import { NamingStrategy, propertyTypeName, extractDefName } from "./naming";
import { generateLexiconJSON } from "./generate-lexicon";
import { generateTypeScriptDeclarations } from "./generate-typescript";
import {
  generateRuntimeIndex as coreGenerateRuntimeIndex,
  type RuntimeIndexEntry,
  type RuntimeIndexPropertyEntry,
} from "@intentius/chant/codegen/generate-runtime-index";

export type { GenerateOptions, GenerateResult };

const azurePipelineConfig: GeneratePipelineConfig<ArmSchemaParseResult> = {
  fetchSchemas: async (opts) => {
    return fetchArmSchemas(opts.force);
  },

  parseSchema: (_typeName, data) => {
    const result = parseArmSchema(data);
    if (!result.resource.typeName) return null;
    return result;
  },

  createNaming: (results) => new NamingStrategy(results),

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

/**
 * Run the full Azure generation pipeline.
 */
export async function generate(opts: GenerateOptions = {}): Promise<GenerateResult> {
  return generatePipeline(azurePipelineConfig, opts);
}

/**
 * Write generated artifacts to disk.
 */
export function writeGeneratedFiles(result: GenerateResult, baseDir: string): void {
  writeGeneratedArtifacts({
    baseDir,
    files: {
      "lexicon-azure.json": result.lexiconJSON,
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

/**
 * Generate the runtime index.ts with factory constructor exports.
 */
function generateRuntimeIndex(
  results: ArmSchemaParseResult[],
  naming: NamingStrategy,
): string {
  const resourceEntries: RuntimeIndexEntry[] = [];
  const propertyEntries: RuntimeIndexPropertyEntry[] = [];

  for (const r of results) {
    const armType = r.resource.typeName;
    const tsName = naming.resolve(armType);
    if (!tsName) continue;

    // Build attrs map
    const attrs: Record<string, string> = {};
    for (const a of r.resource.attributes) {
      attrs[a.name] = a.name;
    }

    resourceEntries.push({ tsName, resourceType: armType, attrs });

    for (const alias of naming.aliases(armType)) {
      resourceEntries.push({ tsName: alias, resourceType: armType, attrs });
    }

    // Property types
    const shortName = armShortName(armType);
    const ptAliases = naming.propertyTypeAliases(armType);
    for (const pt of r.propertyTypes) {
      const defName = extractDefName(pt.name, shortName);
      const ptName = propertyTypeName(tsName, defName);
      const ptArmType = `${armType}.${pt.specType}`;
      propertyEntries.push({ tsName: ptName, resourceType: ptArmType });

      if (ptAliases) {
        const aliasName = ptAliases.get(defName);
        if (aliasName) {
          propertyEntries.push({ tsName: aliasName, resourceType: ptArmType });
        }
      }
    }
  }

  return coreGenerateRuntimeIndex(resourceEntries, propertyEntries, {
    lexiconName: "azure",
    intrinsicReExports: {
      names: ["ResourceId", "Reference", "Concat", "ResourceGroup", "Subscription", "UniqueString", "Format", "If", "ListKeys"],
      from: "../intrinsics",
    },
    pseudoReExports: {
      names: ["Azure", "ResourceGroupName", "ResourceGroupLocation", "ResourceGroupId", "SubscriptionId", "TenantId", "DeploymentName"],
      from: "../pseudo",
    },
  });
}
