/**
 * GitLab CI generation pipeline — uses core generatePipeline
 * with GitLab-specific fetch, parse, naming, and generation callbacks.
 */

import { join } from "path";
import {
  generatePipeline,
  writeGeneratedArtifacts,
  type GenerateOptions,
  type GenerateResult,
  type GeneratePipelineConfig,
} from "@intentius/chant/codegen/generate";
import { fetchSchemas } from "./fetch";
import { parseCISchema, type GitLabParseResult } from "./parse";
import { NamingStrategy, propertyTypeName, extractDefName } from "./naming";
import { gitlabShortName } from "./parse";
import { generateLexiconJSON } from "./generate-lexicon";
import { generateTypeScriptDeclarations } from "./generate-typescript";
import {
  generateRuntimeIndex as coreGenerateRuntimeIndex,
  type RuntimeIndexEntry,
  type RuntimeIndexPropertyEntry,
} from "@intentius/chant/codegen/generate-runtime-index";

export type { GenerateResult };

export interface GitLabGenerateOptions extends GenerateOptions {
  /** GitLab ref (tag, branch, or SHA) to fetch the schema from. */
  schemaVersion?: string;
}

// Captured from generate() call so the pipeline config can access it
let activeSchemaVersion: string | undefined;

const gitlabPipelineConfig: GeneratePipelineConfig<GitLabParseResult> = {
  fetchSchemas: async (opts) => {
    return fetchSchemas(opts.force, activeSchemaVersion);
  },

  parseSchema: (_typeName, data) => {
    // The CI schema is a single document — parseCISchema returns multiple results.
    // The pipeline calls this once per schema entry. We return the first result
    // and use augmentResults to inject the rest.
    const results = parseCISchema(data);
    if (results.length === 0) return null;
    // Return the first result; stash the rest for augmentResults
    pendingResults = results.slice(1);
    return results[0];
  },

  createNaming: (results) => new NamingStrategy(results),

  augmentResults: (results, _opts, log) => {
    // Add the remaining results from the single-schema parse
    if (pendingResults.length > 0) {
      results.push(...pendingResults);
      log(`Added ${pendingResults.length} additional CI entities from single schema`);
      pendingResults = [];
    }
    log(`Total: ${results.length} CI entity schemas`);
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

// Shared state between parseSchema and augmentResults
let pendingResults: GitLabParseResult[] = [];

/**
 * Run the full GitLab generation pipeline.
 */
export async function generate(opts: GitLabGenerateOptions = {}): Promise<GenerateResult> {
  pendingResults = [];
  activeSchemaVersion = opts.schemaVersion;
  return generatePipeline(gitlabPipelineConfig, opts);
}

/**
 * Write generated artifacts to disk.
 */
export function writeGeneratedFiles(result: GenerateResult, baseDir: string): void {
  writeGeneratedArtifacts({
    baseDir,
    files: {
      "lexicon-gitlab.json": result.lexiconJSON,
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
  results: GitLabParseResult[],
  naming: NamingStrategy,
): string {
  const resourceEntries: RuntimeIndexEntry[] = [];
  const propertyEntries: RuntimeIndexPropertyEntry[] = [];

  for (const r of results) {
    const typeName = r.resource.typeName;
    const tsName = naming.resolve(typeName);
    if (!tsName) continue;

    // CI entities have no read-only attributes
    const attrs: Record<string, string> = {};

    if (r.isProperty) {
      // Property-kind entities (Artifacts, Cache, Image, etc.)
      propertyEntries.push({ tsName, resourceType: typeName });
      for (const alias of naming.aliases(typeName)) {
        propertyEntries.push({ tsName: alias, resourceType: typeName });
      }
    } else {
      // Resource-kind entities (Job, Default, Workflow)
      resourceEntries.push({ tsName, resourceType: typeName, attrs });
      for (const alias of naming.aliases(typeName)) {
        resourceEntries.push({ tsName: alias, resourceType: typeName, attrs });
      }
    }

    // Property types
    const shortName = gitlabShortName(typeName);
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
    lexiconName: "gitlab",
    intrinsicReExports: {
      names: ["reference"],
      from: "../intrinsics",
    },
    pseudoReExports: {
      names: ["CI"],
      from: "../variables",
    },
  });
}
