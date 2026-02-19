import { generatePipeline, writeGeneratedArtifacts } from "@intentius/chant/codegen/generate";
import type { GenerateResult } from "@intentius/chant/codegen/generate";
import { dirname } from "path";
import { fileURLToPath } from "url";

/**
 * Run the code generation pipeline.
 *
 * Each callback has a TODO describing what to implement.
 */
export async function generate(options?: { verbose?: boolean }): Promise<GenerateResult> {
  const result = await generatePipeline({
    // Must return Map<typeName, Buffer> — each entry is one schema file.
    // Example: fetch a zip, extract JSON files, key by type name.
    // See lexicons/aws/src/spec/fetch.ts for a working example.
    fetchSchemas: async (opts) => {
      throw new Error("TODO: implement fetchSchemas — download your upstream spec");
    },

    // Must return a ParsedResult (with propertyTypes[] and enums[] at minimum).
    // Return null to skip a schema file.
    // See lexicons/aws/src/spec/parse.ts for a working example.
    parseSchema: (name, data) => {
      throw new Error("TODO: implement parseSchema — parse a single schema file");
    },

    // Must return a NamingStrategy instance.
    // See lexicons/aws/src/codegen/naming.ts and ./naming.ts for setup.
    createNaming: (results) => {
      throw new Error("TODO: implement createNaming — return a NamingStrategy instance");
    },

    // Must return a string of JSON (the lexicon registry).
    // Use buildRegistry + serializeRegistry from @intentius/chant/codegen/generate-registry.
    // See lexicons/aws/src/codegen/generate.ts for a working example.
    generateRegistry: (results, naming) => {
      throw new Error("TODO: implement generateRegistry — produce lexicon JSON");
    },

    // Must return a string of TypeScript declarations (.d.ts content).
    // See lexicons/aws/src/codegen/generate.ts for a working example.
    generateTypes: (results, naming) => {
      throw new Error("TODO: implement generateTypes — produce .d.ts content");
    },

    // Must return a string of TypeScript (runtime index with factory exports).
    // Use generateRuntimeIndex from @intentius/chant/codegen/generate-runtime-index.
    // See lexicons/aws/src/codegen/generate.ts for a working example.
    generateRuntimeIndex: (results, naming) => {
      throw new Error("TODO: implement generateRuntimeIndex — produce index.ts content");
    },
  });

  if (options?.verbose) {
    console.error(`Generated ${result.resources} resources, ${result.properties} property types`);
  }

  return result;
}

/**
 * Write generated files to the package directory.
 */
export function writeGeneratedFiles(result: GenerateResult, pkgDir?: string): void {
  const dir = pkgDir ?? dirname(dirname(fileURLToPath(import.meta.url)));
  writeGeneratedArtifacts({
    baseDir: dir,
    files: {
      "lexicon.json": result.lexiconJSON,
      "index.d.ts": result.typesDTS,
      "index.ts": result.indexTS,
    },
  });
}
