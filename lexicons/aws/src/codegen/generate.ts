/**
 * AWS CloudFormation generation pipeline — uses core generatePipeline
 * with AWS-specific fetch, parse, naming, and generation callbacks.
 */

import { existsSync } from "fs";
import { join } from "path";
import {
  generatePipeline,
  writeGeneratedArtifacts,
  type GenerateOptions,
  type GenerateResult,
  type GeneratePipelineConfig,
  type AugmentResult,
} from "@intentius/chant/codegen/generate";
import { fetchSchemaZip } from "../spec/fetch";
import { parseCFNSchema, cfnShortName, type SchemaParseResult } from "../spec/parse";
import { fetchCfnLintPatches, applyPatches } from "./patches";
import { fetchCfnLintExtensions, loadExtensionSchemas, type ExtensionConstraint } from "./extensions";
import { samResources } from "./sam";
import { fallbackResources } from "./fallback";
import { NamingStrategy, propertyTypeName, extractDefName } from "./naming";
import { generateLexiconJSON, lambdaRuntimeDeprecations } from "./generate-lexicon";
import { generateTypeScriptDeclarations } from "./generate-typescript";
import {
  generateRuntimeIndex as coreGenerateRuntimeIndex,
  type RuntimeIndexEntry,
  type RuntimeIndexPropertyEntry,
} from "@intentius/chant/codegen/generate-runtime-index";

export type { GenerateOptions, GenerateResult };

// AWS-specific state shared between pipeline callbacks
let awsConstraints = new Map<string, ExtensionConstraint[]>();

const awsPipelineConfig: GeneratePipelineConfig<SchemaParseResult> = {
  fetchSchemas: async (opts) => {
    return fetchSchemaZip(opts.force);
  },

  parseSchema: (_typeName, data) => {
    const result = parseCFNSchema(data);
    if (!result.resource.typeName) return null;
    return result;
  },

  createNaming: (results) => new NamingStrategy(results),

  augmentSchemas: async (schemas, opts, log) => {
    const warnings: Array<{ file: string; error: string }> = [];

    // Fetch and apply cfn-lint patches
    try {
      log("Fetching cfn-lint patches...");
      const patchesDir = await fetchCfnLintPatches(opts.force);
      const { schemas: patched, stats } = applyPatches(schemas, patchesDir);
      schemas = patched;
      log(`Applied ${stats.patchesApplied} patches across ${stats.resourcesFixed} resources`);
      for (const w of stats.warnings) {
        warnings.push({ file: `${w.typeName}/${w.patchFile}`, error: w.error.message });
      }
    } catch (err) {
      log(`WARNING: failed to fetch cfn-lint patches: ${err}`);
    }

    // Fetch extension constraints (stored for use in generateRegistry)
    try {
      log("Fetching cfn-lint extensions...");
      const extensionsDir = await fetchCfnLintExtensions(opts.force);
      // We'll apply these later in generateRegistry — store them
      // The parsedTypes set isn't available yet, so we load all and filter later
      awsConstraints = loadExtensionSchemas(extensionsDir, new Set(schemas.keys()));
      log(`Loaded extension constraints for ${awsConstraints.size} resource types`);
    } catch (err) {
      log(`WARNING: failed to fetch cfn-lint extensions: ${err}`);
      awsConstraints = new Map();
    }

    return { schemas, warnings };
  },

  augmentResults: (results, _opts, log) => {
    const warnings: Array<{ file: string; error: string }> = [];

    // Add SAM resources
    results.push(...samResources());
    log("Added SAM resources");

    // Add fallback resources for missing priority types
    const parsedTypes = new Set(results.map((r) => r.resource.typeName));
    for (const fb of fallbackResources()) {
      if (!parsedTypes.has(fb.resource.typeName)) {
        results.push(fb);
        parsedTypes.add(fb.resource.typeName);
        warnings.push({
          file: fb.resource.typeName,
          error: `Priority resource missing from schema zip; using fallback`,
        });
      }
    }

    // Re-filter extension constraints now that we have the full type set
    // (augmentSchemas loaded them before parsing, so we already have them)

    log(`Total: ${results.length} resource schemas`);
    return { results, warnings };
  },

  generateRegistry: (results, naming) => {
    const runtimeDeprecations = lambdaRuntimeDeprecations();
    return generateLexiconJSON(
      results,
      naming as NamingStrategy,
      awsConstraints,
      runtimeDeprecations,
    );
  },

  generateTypes: (results, naming) => {
    return generateTypeScriptDeclarations(results, naming as NamingStrategy);
  },

  generateRuntimeIndex: (results, naming) => {
    return generateRuntimeIndex(results, naming as NamingStrategy);
  },
};

/**
 * Run the full AWS generation pipeline.
 */
export async function generate(opts: GenerateOptions = {}): Promise<GenerateResult> {
  // Reset shared state
  awsConstraints = new Map();
  return generatePipeline(awsPipelineConfig, opts);
}

/**
 * Write generated artifacts to disk.
 */
export function writeGeneratedFiles(result: GenerateResult, baseDir: string): void {
  writeGeneratedArtifacts({
    baseDir,
    files: {
      "lexicon-aws.json": result.lexiconJSON,
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
  results: SchemaParseResult[],
  naming: NamingStrategy,
): string {
  const resourceEntries: RuntimeIndexEntry[] = [];
  const propertyEntries: RuntimeIndexPropertyEntry[] = [];

  for (const r of results) {
    const cfnType = r.resource.typeName;
    const tsName = naming.resolve(cfnType);
    if (!tsName) continue;

    // Build attrs map
    const attrs: Record<string, string> = {};
    for (const a of r.resource.attributes) {
      const camelName = a.name.charAt(0).toLowerCase() + a.name.slice(1);
      attrs[camelName] = a.name;
    }

    resourceEntries.push({ tsName, resourceType: cfnType, attrs });

    for (const alias of naming.aliases(cfnType)) {
      resourceEntries.push({ tsName: alias, resourceType: cfnType, attrs });
    }

    // Property types
    const shortName = cfnShortName(cfnType);
    const ptAliases = naming.propertyTypeAliases(cfnType);
    for (const pt of r.propertyTypes) {
      const defName = extractDefName(pt.name, shortName);
      const ptName = propertyTypeName(tsName, defName);
      const ptCfnType = `${cfnType}.${pt.specType}`;
      propertyEntries.push({ tsName: ptName, resourceType: ptCfnType });

      if (ptAliases) {
        const aliasName = ptAliases.get(defName);
        if (aliasName) {
          propertyEntries.push({ tsName: aliasName, resourceType: ptCfnType });
        }
      }
    }
  }

  return coreGenerateRuntimeIndex(resourceEntries, propertyEntries, {
    lexiconName: "aws",
    intrinsicReExports: {
      names: ["Sub", "Ref", "GetAtt", "If", "Join", "Select", "Split", "Base64"],
      from: "../intrinsics",
    },
    pseudoReExports: {
      names: ["AWS", "StackName", "Region", "AccountId", "StackId", "URLSuffix", "NoValue", "NotificationARNs", "Partition"],
      from: "../pseudo",
    },
  });
}
