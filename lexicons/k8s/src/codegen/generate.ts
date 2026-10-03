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
import {
  parseK8sSwaggerTypes,
  specListMapKeyPairs,
  k8sShortName,
  type K8sParseResult,
  type ParsedDefinitionType,
} from "../spec/parse";
import { loadMultipleCRDs } from "../crd/loader";
import { CRD_SOURCES } from "../crd/crd-sources";
import type { CRDSource } from "../crd/types";
import { NamingStrategy, propertyTypeName, extractDefName } from "./naming";
import { generateLexiconJSON } from "./generate-lexicon";
import { generateOperationsJSON } from "./generate-operations";
import { generateListMapKeysJSON } from "./generate-list-map-keys";
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
  /**
   * Generate without a CRD source that fails to load, as a warning, instead
   * of failing (#3310). For a deliberate offline or partial run only: the
   * output then lacks that source's kinds. Defaults to
   * `CHANT_K8S_ALLOW_CRD_FAILURES=1` in the environment.
   */
  allowCrdFailures?: boolean;
}

/** Where a CRD source comes from, as a log line or an error names it. */
function crdSourceLabel(source: CRDSource): string {
  return source.url ?? source.path ?? source.chart ?? "cluster";
}

/**
 * Load every CRD source. A source that fails to load fails generation and the
 * error names it (#3310): skipping it shrinks the output silently, and the loss
 * shows up only later as a surface-snapshot diff. Every source is tried first,
 * so one run names all the failures. `allowFailures` turns them back into
 * warnings for a deliberate partial run.
 */
export async function loadCrdSources(
  sources: readonly CRDSource[],
  log: (msg: string) => void,
  opts: { allowFailures?: boolean; load?: (sources: CRDSource[]) => Promise<K8sParseResult[]> } = {},
): Promise<{ results: K8sParseResult[]; warnings: Array<{ file: string; error: string }> }> {
  const load = opts.load ?? loadMultipleCRDs;
  const results: K8sParseResult[] = [];
  const failures: Array<{ file: string; error: string }> = [];
  for (const source of sources) {
    const label = crdSourceLabel(source);
    try {
      const parsed = await load([source]);
      results.push(...parsed);
      log(`Loaded ${parsed.length} CRD type(s) from ${label}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push({ file: label, error: msg });
      log(`${opts.allowFailures ? "Warning: skipping" : "Error:"} CRD source ${label} failed to load: ${msg}`);
    }
  }
  if (failures.length > 0 && !opts.allowFailures) {
    const lines = failures.map((f) => `  ${f.file}: ${f.error}`).join("\n");
    throw new Error(
      `${failures.length} CRD source(s) failed to load, so generation would drop their kinds:\n${lines}\n` +
        `Set CHANT_K8S_ALLOW_CRD_FAILURES=1 to generate without them deliberately.`,
    );
  }
  log(`Total CRD types loaded: ${results.length}`);
  return { results, warnings: failures };
}

/**
 * Run the full Kubernetes generation pipeline.
 */
export async function generate(opts: K8sGenerateOptions = {}): Promise<GenerateResult> {
  // Pipeline state captured in closure — no module-level mutation
  let pendingResults: K8sParseResult[] = [];
  // chant #1441 — read off the raw document in `parseSchema`, since the
  // result set covers only the definitions chant emits types for.
  let specPairs: Array<[string, string[]]> = [];
  // chant #3093 — the declaration-only interfaces, which only the `.d.ts` emits.
  let definitionTypes: ParsedDefinitionType[] = [];

  const config: GeneratePipelineConfig<K8sParseResult> = {
    fetchSchemas: async (fetchOpts) => {
      return fetchSchemas(fetchOpts.force, opts.schemaVersion);
    },

    parseSchema: (_typeName, data) => {
      // The K8s schema is a single document — parseK8sSwaggerTypes returns multiple results.
      // The pipeline calls this once per schema entry. We return the first result
      // and use augmentResults to inject the rest.
      const { results, definitionTypes: defs } = parseK8sSwaggerTypes(data);
      definitionTypes = defs;
      specPairs = specListMapKeyPairs(data);
      if (results.length === 0) return null;
      // Return the first result; stash the rest for augmentResults
      pendingResults = results.slice(1);
      return results[0];
    },

    createNaming: (results) => new NamingStrategy(results),

    augmentSchemas: async (schemas, _opts, log) => {
      // Load third-party CRDs and return as extraResults so they are
      // included in the generated types alongside the core K8s resources.
      const allowFailures = opts.allowCrdFailures ?? process.env.CHANT_K8S_ALLOW_CRD_FAILURES === "1";
      const { results: crdResults, warnings } = await loadCrdSources(CRD_SOURCES, log, { allowFailures });
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
      return generateTypeScriptDeclarations(results, naming as NamingStrategy, definitionTypes);
    },

    generateRuntimeIndex: (results, naming) => {
      return generateRuntimeIndex(results, naming as NamingStrategy);
    },

    // chant #1074 — the operation surface, out of the same results the types
    // and the registry come out of, so the live client cannot address a kind
    // differently from how the declarable surface names it.
    generateExtraArtifacts: (results) => ({
      "operations.json": generateOperationsJSON(results),
      // chant #1441 — the spec's own associative-list keys, so drift compares
      // list elements by identity instead of by index.
      "list-map-keys.json": generateListMapKeysJSON(specPairs, results),
    }),
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
      ...(result.extraArtifacts ?? {}),
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
