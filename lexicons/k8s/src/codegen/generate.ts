/**
 * Kubernetes generation pipeline — uses core generatePipeline
 * with K8s-specific fetch, parse, naming, and generation callbacks.
 */

import { join } from "path";
import {
  generatePipeline,
  writeGeneratedArtifacts,
  type GenerateOptions,
  type GenerateResult,
  type GeneratePipelineConfig,
} from "@intentius/chant/codegen/generate";
import { fetchSchemas } from "../spec/fetch";
import { parseK8sSwagger, k8sShortName, type K8sParseResult } from "../spec/parse";
import { loadMultipleCRDs } from "../crd/loader";
import { CRD_SOURCES } from "../crd/crd-sources";
import { NamingStrategy, propertyTypeName, extractDefName } from "./naming";
import { generateLexiconJSON } from "./generate-lexicon";
import { generateTypeScriptDeclarations } from "./generate-typescript";
import {
  generateRuntimeIndex as coreGenerateRuntimeIndex,
  type RuntimeIndexEntry,
  type RuntimeIndexPropertyEntry,
} from "@intentius/chant/codegen/generate-runtime-index";

export type { GenerateResult };

export interface K8sGenerateOptions extends GenerateOptions {
  /** Kubernetes version tag to fetch the schema from. */
  schemaVersion?: string;
}

/**
 * Run the full Kubernetes generation pipeline.
 */
export async function generate(opts: K8sGenerateOptions = {}): Promise<GenerateResult> {
  // Pipeline state captured in closure — no module-level mutation
  let pendingResults: K8sParseResult[] = [];

  const config: GeneratePipelineConfig<K8sParseResult> = {
    fetchSchemas: async (fetchOpts) => {
      return fetchSchemas(fetchOpts.force, opts.schemaVersion);
    },

    parseSchema: (_typeName, data) => {
      // The K8s schema is a single document — parseK8sSwagger returns multiple results.
      // The pipeline calls this once per schema entry. We return the first result
      // and use augmentResults to inject the rest.
      const results = parseK8sSwagger(data);
      if (results.length === 0) return null;
      // Return the first result; stash the rest for augmentResults
      pendingResults = results.slice(1);
      return results[0];
    },

    createNaming: (results) => new NamingStrategy(results),

    augmentSchemas: async (schemas, _opts, log) => {
      // Load third-party CRDs and return as extraResults so they are
      // included in the generated types alongside the core K8s resources.
      const crdResults: K8sParseResult[] = [];
      const warnings: Array<{ file: string; error: string }> = [];
      for (const source of CRD_SOURCES) {
        try {
          const parsed = await loadMultipleCRDs([source]);
          crdResults.push(...parsed);
          log(`Loaded ${parsed.length} CRD type(s) from ${source.url ?? source.path ?? "cluster"}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          warnings.push({ file: source.url ?? source.path ?? "cluster", error: msg });
          log(`Warning: failed to load CRD: ${msg}`);
        }
      }
      log(`Total CRD types loaded: ${crdResults.length}`);
      return { schemas, extraResults: crdResults, warnings };
    },

    augmentResults: (results, _opts, log) => {
      // Add the remaining results from the single-schema parse
      if (pendingResults.length > 0) {
        results.push(...pendingResults);
        log(`Added ${pendingResults.length} additional K8s resources from OpenAPI spec`);
        pendingResults = [];
      }
      log(`Total: ${results.length} K8s resource/property schemas`);
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
export function writeGeneratedFiles(result: GenerateResult, baseDir: string): void {
  writeGeneratedArtifacts({
    baseDir,
    files: {
      "lexicon-k8s.json": result.lexiconJSON,
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
  results: K8sParseResult[],
  naming: NamingStrategy,
): string {
  const resourceEntries: RuntimeIndexEntry[] = [];
  const propertyEntries: RuntimeIndexPropertyEntry[] = [];

  for (const r of results) {
    const typeName = r.resource.typeName;
    const tsName = naming.resolve(typeName);
    if (!tsName) continue;

    const attrs: Record<string, string> = {};
    for (const attr of r.resource.attributes) {
      attrs[attr.name] = attr.name;
    }

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

    // Nested property types
    const shortName = k8sShortName(typeName);
    for (const pt of r.propertyTypes) {
      const defName = extractDefName(pt.name, shortName);
      const ptName = propertyTypeName(tsName, defName);
      const ptType = `${typeName}.${pt.defType}`;
      propertyEntries.push({ tsName: ptName, resourceType: ptType });
    }
  }

  return coreGenerateRuntimeIndex(resourceEntries, propertyEntries, {
    lexiconName: "k8s",
  });
}
