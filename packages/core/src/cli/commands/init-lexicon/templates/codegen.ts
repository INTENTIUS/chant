/**
 * Codegen template generators for init-lexicon scaffold.
 */

export function generateCodegenGenerateTs(): string {
  return `import { generatePipeline, writeGeneratedArtifacts } from "@intentius/chant/codegen/generate";
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
    console.error(\`Generated \${result.resources} resources, \${result.properties} property types\`);
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
`;
}

export function generateCodegenGenerateCliTs(): string {
  return `#!/usr/bin/env tsx
import { generate, writeGeneratedFiles } from "./generate";
import { dirname } from "path";
import { fileURLToPath } from "url";

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
const result = await generate({ verbose: true });
writeGeneratedFiles(result, pkgDir);
`;
}

export function generateCodegenNamingTs(): string {
  return `import { NamingStrategy, type NamingConfig, type NamingInput } from "@intentius/chant/codegen/naming";

/**
 * Naming configuration for this lexicon.
 *
 * TODO: Populate these tables with your provider's naming conventions.
 */
export const namingConfig: NamingConfig = {
  // High-priority short names for common resource types
  priorityNames: {},

  // Aliases for resource types that need alternate names
  priorityAliases: {},

  // Aliases for property types
  priorityPropertyAliases: {},

  // Abbreviations for service names (used in collision resolution)
  serviceAbbreviations: {},

  // Extract the short name from a fully-qualified type string
  shortName: (typeName: string) => typeName.split("::").pop()!,

  // Extract the service name from a fully-qualified type string
  serviceName: (typeName: string) => typeName.split("::")[1] ?? typeName,
};

/**
 * Create a NamingStrategy instance from parsed results.
 */
export function createNaming(inputs: NamingInput[]): NamingStrategy {
  return new NamingStrategy(inputs, namingConfig);
}
`;
}

export function generateCodegenPackageTs(name: string): string {
  return `import { packagePipeline } from "@intentius/chant/codegen/package";
import type { PackagePipelineConfig } from "@intentius/chant/codegen/package";
import { generate } from "./generate";
import { dirname } from "path";
import { fileURLToPath } from "url";

/**
 * Package the ${name} lexicon for distribution.
 */
export async function packageLexicon(options?: { verbose?: boolean; force?: boolean }) {
  const srcDir = dirname(fileURLToPath(import.meta.url));

  const { spec, stats } = await packagePipeline({
    generate: (opts) => generate({ verbose: opts?.verbose, force: opts?.force }),
    buildManifest: (genResult) => ({
      name: "${name}",
      version: "0.0.1",
    }),
    srcDir,
    collectSkills: () => new Map(),
  });

  console.error(\`Packaged \${stats.resources} resources, \${stats.ruleCount} rules\`);
  return { spec, stats };
}
`;
}

export function generateCodegenDocsTs(name: string): string {
  return `import { docsPipeline, writeDocsSite } from "@intentius/chant/codegen/docs";

/**
 * Generate documentation site for the ${name} lexicon.
 */
export async function generateDocs(options?: { verbose?: boolean }): Promise<void> {
  const config = {
    name: "${name}",
    displayName: "${name.charAt(0).toUpperCase() + name.slice(1)}",
    description: "${name} lexicon documentation",
    distDir: "./dist",
    outDir: "./docs",
    // TODO: Implement service grouping for your provider
    serviceFromType: (type: string) => type.split("::")[1] ?? type,
    // TODO: Implement resource documentation URLs
    resourceTypeUrl: (type: string) => \`#\${type}\`,
  };

  const result = docsPipeline(config);
  writeDocsSite(config, result);

  if (options?.verbose) {
    console.error("Documentation generated");
  }
}
`;
}
