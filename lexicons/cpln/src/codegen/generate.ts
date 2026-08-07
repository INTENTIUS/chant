/**
 * cpln generation pipeline — core `generatePipeline` with cpln's fetch, parse,
 * naming and emit callbacks.
 */

import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import {
  generatePipeline,
  writeGeneratedArtifacts,
  type GenerateOptions,
  type GenerateResult,
  type GeneratePipelineConfig,
} from "@intentius/chant/codegen/generate";
import {
  generateRuntimeIndex as coreGenerateRuntimeIndex,
  type RuntimeIndexEntry,
  type RuntimeIndexPropertyEntry,
} from "@intentius/chant/codegen/generate-runtime-index";
import { fetchSchemas } from "../spec/fetch";
import { parseCplnOpenAPI, type CplnParseResult } from "../spec/parse";
import { NamingStrategy } from "./naming";
import { generateLexiconJSON } from "./generate-lexicon";
import { generateTypeScriptDeclarations } from "./generate-typescript";

export type { GenerateResult };

const PKG_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const SURFACE_SNAPSHOT = join(PKG_DIR, "surface.snapshot.json");

/**
 * Read the committed surface snapshot, when there is one.
 *
 * Absent before the first publish, which is the honest state for a lexicon
 * with no published names to protect — the naming strategy simply has nothing
 * to reserve.
 */
function readSurfaceSnapshot(): { entries?: Record<string, { kind?: string; resourceType?: string }> } | undefined {
  if (!existsSync(SURFACE_SNAPSHOT)) return undefined;
  try {
    return JSON.parse(readFileSync(SURFACE_SNAPSHOT, "utf-8"));
  } catch {
    return undefined;
  }
}

/**
 * Run the full cpln generation pipeline.
 */
export async function generate(opts: GenerateOptions = {}): Promise<GenerateResult> {
  const config: GeneratePipelineConfig<CplnParseResult> = {
    fetchSchemas: (fetchOpts) => fetchSchemas({ force: fetchOpts.force }),

    // The spec is one document and `parseSchema` is called once with it; the
    // pipeline accepts an array back, so there is no need for fly's
    // parse-once-stash-the-rest dance.
    parseSchema: (_typeName, data) => parseCplnOpenAPI(data),

    createNaming: (results) => new NamingStrategy(results, { snapshot: readSurfaceSnapshot() }),

    generateRegistry: (results, naming) => generateLexiconJSON(results, naming as NamingStrategy),

    generateTypes: (results, naming) => generateTypeScriptDeclarations(results, naming as NamingStrategy),

    generateRuntimeIndex: (results, naming) => buildRuntimeIndex(results, naming as NamingStrategy),
  };

  return generatePipeline(config, opts);
}

/**
 * Write generated artifacts under `src/generated/`.
 */
export function writeGeneratedFiles(result: GenerateResult, baseDir: string): void {
  writeGeneratedArtifacts({
    baseDir,
    files: {
      "lexicon-cpln.json": result.lexiconJSON,
      "index.d.ts": result.typesDTS,
      "index.ts": result.indexTS,
      "runtime.ts": `/**\n * Runtime factory constructors — re-exported from core.\n */\nexport { createResource, createProperty } from "@intentius/chant/runtime";\n`,
    },
  });
}

/**
 * Build the runtime index with the factory constructor exports.
 */
function buildRuntimeIndex(results: CplnParseResult[], naming: NamingStrategy): string {
  const resourceEntries: RuntimeIndexEntry[] = [];
  const propertyEntries: RuntimeIndexPropertyEntry[] = [];

  for (const r of results) {
    const typeName = r.resource.typeName;
    const tsName = naming.resolve(typeName);
    if (!tsName) continue;

    if (r.isProperty) {
      propertyEntries.push({ tsName, resourceType: typeName });
      continue;
    }

    const attrs: Record<string, string> = {};
    for (const attr of r.resource.attributes) attrs[attr.name] = attr.name;
    resourceEntries.push({ tsName, resourceType: typeName, attrs });
  }

  return coreGenerateRuntimeIndex(resourceEntries, propertyEntries, { lexiconName: "cpln" });
}
