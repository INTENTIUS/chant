import { existsSync, mkdirSync, writeFileSync, readdirSync } from "fs";
import { join, resolve } from "path";
import { formatSuccess, formatWarning } from "../format";

/**
 * Init-lexicon command options
 */
export interface InitLexiconOptions {
  /** Lexicon name (e.g. "k8s") */
  name: string;
  /** Target directory (defaults to ./lexicons/<name>) */
  path?: string;
  /** Force init even in non-empty directory */
  force?: boolean;
  /** Skip install prompt */
  skipInstall?: boolean;
}

/**
 * Init-lexicon command result
 */
export interface InitLexiconResult {
  success: boolean;
  createdFiles: string[];
  warnings: string[];
  error?: string;
}

// ── Name derivation helpers ──────────────────────────────────────────

function toCamelCase(name: string): string {
  return name.replace(/[-_]+(.)/g, (_, c) => c.toUpperCase());
}

function deriveNames(name: string) {
  const camel = toCamelCase(name);
  return {
    pluginVarName: `${camel}Plugin`,
    serializerVarName: `${camel}Serializer`,
    rulePrefix: name.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3),
    packageName: `@intentius/chant-lexicon-${name}`,
  };
}

// ── writeIfNotExists ─────────────────────────────────────────────────

function writeIfNotExists(
  filePath: string,
  content: string,
  relativePath: string,
  createdFiles: string[],
  warnings: string[],
): void {
  if (!existsSync(filePath)) {
    writeFileSync(filePath, content);
    createdFiles.push(relativePath);
  } else {
    warnings.push(`${relativePath} already exists, skipping`);
  }
}

// ── Template generators ──────────────────────────────────────────────

function generatePluginTs(name: string, names: ReturnType<typeof deriveNames>): string {
  return `import type { LexiconPlugin } from "@intentius/chant/lexicon";
import { ${names.serializerVarName} } from "./serializer";

/**
 * ${name} lexicon plugin.
 *
 * Implements all required LexiconPlugin lifecycle methods.
 */
export const ${names.pluginVarName}: LexiconPlugin = {
  name: "${name}",
  serializer: ${names.serializerVarName},

  // ── Required lifecycle methods ────────────────────────────────

  async generate(options?: { verbose?: boolean }): Promise<void> {
    const { generate } = await import("./codegen/generate");
    await generate(options);
  },

  async validate(options?: { verbose?: boolean }): Promise<void> {
    const { validate } = await import("./validate");
    const { printValidationResult } = await import("@intentius/chant/codegen/validate");
    const result = await validate();
    printValidationResult(result);
  },

  async coverage(options?: { verbose?: boolean; minOverall?: number }): Promise<void> {
    // TODO: Implement coverage analysis
    console.error("Coverage analysis not yet implemented");
  },

  async package(options?: { verbose?: boolean; force?: boolean }): Promise<void> {
    const { packageLexicon } = await import("./codegen/package");
    const { writeBundleSpec } = await import("@intentius/chant/codegen/package");
    const { join, dirname } = await import("path");
    const { fileURLToPath } = await import("url");

    const { spec, stats } = await packageLexicon(options);
    const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
    writeBundleSpec(spec, join(pkgDir, "dist"));

    console.error(\`Packaged \${stats.resources} resources, \${stats.ruleCount} rules, \${stats.skillCount} skills\`);
  },

  async rollback(options?: { restore?: string; verbose?: boolean }): Promise<void> {
    const { listSnapshots, restoreSnapshot } = await import("./codegen/rollback");
    const { join, dirname } = await import("path");
    const { fileURLToPath } = await import("url");

    const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
    const snapshotsDir = join(pkgDir, ".snapshots");

    if (options?.restore) {
      const generatedDir = join(pkgDir, "src", "generated");
      restoreSnapshot(String(options.restore), generatedDir);
      console.error(\`Restored snapshot: \${options.restore}\`);
    } else {
      const snapshots = listSnapshots(snapshotsDir);
      if (snapshots.length === 0) {
        console.error("No snapshots available.");
      } else {
        console.error(\`Available snapshots (\${snapshots.length}):\`);
        for (const s of snapshots) {
          console.error(\`  \${s.timestamp}  \${s.resources} resources  \${s.path}\`);
        }
      }
    }
  },

  // ── Optional extensions (uncomment and implement as needed) ───

  // lintRules(): LintRule[] {
  //   return [];
  // },

  // declarativeRules(): RuleSpec[] {
  //   return [];
  // },

  // postSynthChecks(): PostSynthCheck[] {
  //   return [];
  // },

  // intrinsics(): IntrinsicDef[] {
  //   return [];
  // },

  // pseudoParameters(): string[] {
  //   return [];
  // },

  // detectTemplate(data: unknown): boolean {
  //   return false;
  // },

  // templateParser(): TemplateParser {
  //   // return new MyParser();
  // },

  // templateGenerator(): TypeScriptGenerator {
  //   // return new MyGenerator();
  // },

  // skills(): SkillDefinition[] {
  //   return [];
  // },

  // completionProvider(ctx: CompletionContext): CompletionItem[] {
  //   return [];
  // },

  // hoverProvider(ctx: HoverContext): HoverInfo | undefined {
  //   return undefined;
  // },

  // docs(options?: { verbose?: boolean }): Promise<void> {
  //   const { generateDocs } = await import("./codegen/docs");
  //   return generateDocs(options);
  // },
};
`;
}

function generateIndexTs(names: ReturnType<typeof deriveNames>): string {
  return `// Plugin
export { ${names.pluginVarName} } from "./plugin";

// Serializer
export { ${names.serializerVarName} } from "./serializer";

// Generated resources — export everything from generated index
// After running \`chant generate\`, this re-exports all resource classes
// export * from "./generated/index";
`;
}

function generateSerializerTs(name: string, names: ReturnType<typeof deriveNames>): string {
  return `import type { Serializer, Declarable } from "@intentius/chant";

/**
 * ${name} serializer — produces minimal JSON output.
 *
 * TODO: Replace with your lexicon's output format.
 */
export const ${names.serializerVarName}: Serializer = {
  name: "${name}",
  rulePrefix: "${names.rulePrefix}",

  serialize(entities: Map<string, Declarable>): string {
    const resources: Record<string, unknown> = {};

    for (const [entityName, entity] of entities) {
      resources[entityName] = {
        type: entity.entityType,
        // TODO: Convert entity properties to your output format
      };
    }

    return JSON.stringify({ resources }, null, 2);
  },
};
`;
}

function generateCodegenGenerateTs(): string {
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

function generateCodegenGenerateCliTs(): string {
  return `#!/usr/bin/env bun
import { generate, writeGeneratedFiles } from "./generate";
import { dirname } from "path";
import { fileURLToPath } from "url";

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
const result = await generate({ verbose: true });
writeGeneratedFiles(result, pkgDir);
`;
}

function generateCodegenNamingTs(): string {
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

function generateCodegenPackageTs(name: string): string {
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

function generateCodegenRollbackTs(): string {
  return `import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync, cpSync } from "fs";
import { join, basename } from "path";

export interface Snapshot {
  timestamp: string;
  resources: number;
  path: string;
}

/**
 * List available generation snapshots.
 */
export function listSnapshots(snapshotsDir: string): Snapshot[] {
  if (!existsSync(snapshotsDir)) return [];

  return readdirSync(snapshotsDir)
    .filter((d) => !d.startsWith("."))
    .sort()
    .reverse()
    .map((dir) => {
      const fullPath = join(snapshotsDir, dir);
      const metaPath = join(fullPath, "meta.json");
      let resources = 0;
      if (existsSync(metaPath)) {
        try {
          const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
          resources = meta.resources ?? 0;
        } catch {}
      }
      return { timestamp: dir, resources, path: fullPath };
    });
}

/**
 * Restore a snapshot to the generated directory.
 */
export function restoreSnapshot(timestamp: string, generatedDir: string): void {
  const snapshotsDir = join(generatedDir, "..", "..", ".snapshots");
  const snapshotDir = join(snapshotsDir, timestamp);
  if (!existsSync(snapshotDir)) {
    throw new Error(\`Snapshot not found: \${timestamp}\`);
  }
  mkdirSync(generatedDir, { recursive: true });
  cpSync(snapshotDir, generatedDir, { recursive: true });
}
`;
}

function generateCodegenDocsTs(name: string): string {
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

function generateSpecFetchTs(): string {
  return `import { fetchWithCache, extractFromZip } from "@intentius/chant/codegen/fetch";

// TODO: Set this to your upstream schema source URL
const SCHEMA_URL = "https://example.com/schemas.zip";
const CACHE_FILE = ".cache/schemas.zip";

/**
 * Fetch upstream schemas with caching.
 *
 * TODO: Point SCHEMA_URL at your real upstream schema source.
 */
export async function fetchSchemas(options?: { force?: boolean }): Promise<Map<string, string>> {
  const zipData = await fetchWithCache({
    url: SCHEMA_URL,
    cacheFile: CACHE_FILE,
    force: options?.force,
  });

  // TODO: Adjust the filter to match your schema file names
  return extractFromZip(zipData, (name) => name.endsWith(".json"));
}
`;
}

function generateSpecParseTs(): string {
  return `/**
 * Parsed schema result for a single schema file.
 */
export interface ParseResult {
  typeName: string;
  description?: string;
  properties: Map<string, ParsedProperty>;
  attributes: string[];
}

export interface ParsedProperty {
  name: string;
  type: string;
  required: boolean;
  description?: string;
}

/**
 * Parse a single schema file into a ParseResult.
 *
 * TODO: Implement parsing for your schema format.
 */
export function parseSchema(name: string, content: string): ParseResult {
  throw new Error(\`TODO: implement parseSchema for \${name}\`);
}
`;
}

function generateSampleRuleTs(names: ReturnType<typeof deriveNames>): string {
  return `import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";

/**
 * ${names.rulePrefix}001: Sample lint rule
 *
 * TODO: Replace with a real lint rule for your lexicon.
 */
export const sampleRule: LintRule = {
  id: "${names.rulePrefix}001",
  severity: "warning",
  category: "style",
  description: "Sample lint rule — replace with real checks",

  check(context: LintContext): LintDiagnostic[] {
    // TODO: Implement rule logic
    return [];
  },
};
`;
}

function generateLintRulesIndexTs(): string {
  return `export { sampleRule } from "./sample";
`;
}

function generateLspCompletionsTs(name: string): string {
  return `import type { CompletionContext, CompletionItem } from "@intentius/chant/lsp/types";
// import { LexiconIndex, lexiconCompletions } from "@intentius/chant/lsp/lexicon-providers";

/**
 * Provide LSP completions for ${name} resources.
 *
 * TODO: Build a LexiconIndex from your generated lexicon data
 * and delegate to lexiconCompletions().
 */
export function completions(ctx: CompletionContext): CompletionItem[] {
  // const index = new LexiconIndex(lexiconData);
  // return lexiconCompletions(ctx, index, "${name} resource");
  return [];
}
`;
}

function generateLspHoverTs(name: string): string {
  return `import type { HoverContext, HoverInfo } from "@intentius/chant/lsp/types";
// import { LexiconIndex, lexiconHover } from "@intentius/chant/lsp/lexicon-providers";

/**
 * Provide LSP hover information for ${name} resources.
 *
 * TODO: Build a LexiconIndex from your generated lexicon data
 * and delegate to lexiconHover().
 */
export function hover(ctx: HoverContext): HoverInfo | undefined {
  // const index = new LexiconIndex(lexiconData);
  // return lexiconHover(ctx, index, myCustomHoverFormatter);
  return undefined;
}
`;
}

function generateImportParserTs(name: string): string {
  return `import type { TemplateParser } from "@intentius/chant/import/parser";

/**
 * Template parser for importing external ${name} templates.
 *
 * TODO: Implement the TemplateParser interface for your format.
 */
// export class ${name.charAt(0).toUpperCase() + name.slice(1)}Parser implements TemplateParser {
//   parse(data: unknown): IR { ... }
// }
`;
}

function generateImportGeneratorTs(name: string): string {
  return `import type { TypeScriptGenerator } from "@intentius/chant/import/generator";

/**
 * TypeScript generator for converting imported ${name} templates.
 *
 * TODO: Implement the TypeScriptGenerator interface for your format.
 */
// export class ${name.charAt(0).toUpperCase() + name.slice(1)}Generator implements TypeScriptGenerator {
//   generate(ir: IR): string { ... }
// }
`;
}

function generateCoverageTs(name: string): string {
  return `/**
 * Coverage analysis for the ${name} lexicon.
 *
 * TODO: Implement coverage analysis that checks how much of the
 * upstream spec is covered by the generated types.
 */
export async function analyzeCoverage(options?: { verbose?: boolean }): Promise<void> {
  console.error("Coverage analysis not yet implemented");
  // TODO: Read generated lexicon JSON, compare against upstream spec,
  // and report coverage metrics.
}
`;
}

function generateValidateTs(name: string): string {
  return `/**
 * Validate generated lexicon-${name} artifacts.
 *
 * Thin wrapper around the core validation framework
 * with ${name}-specific configuration.
 */

import { dirname } from "path";
import { fileURLToPath } from "url";
import { validateLexiconArtifacts, type ValidateResult } from "@intentius/chant/codegen/validate";

export type { ValidateCheck, ValidateResult } from "@intentius/chant/codegen/validate";

// TODO: Add names of required entities for your lexicon
const REQUIRED_NAMES: string[] = [];

/**
 * Validate the generated lexicon-${name} artifacts.
 */
export async function validate(opts?: { basePath?: string }): Promise<ValidateResult> {
  const basePath = opts?.basePath ?? dirname(dirname(fileURLToPath(import.meta.url)));

  return validateLexiconArtifacts({
    lexiconJsonFilename: "lexicon-${name}.json",
    requiredNames: REQUIRED_NAMES,
    basePath,
  });
}
`;
}

function generateValidateCliTs(): string {
  return `#!/usr/bin/env bun
import { validate } from "./validate";

await validate({ verbose: true });
`;
}

function generatePackageJson(name: string, names: ReturnType<typeof deriveNames>): string {
  const pkg = {
    name: names.packageName,
    version: "0.0.1",
    type: "module",
    private: true,
    files: ["src/", "dist/"],
    exports: {
      ".": "./src/index.ts",
      "./*": "./src/*",
      "./manifest": "./dist/manifest.json",
      "./meta": "./dist/meta.json",
      "./types": "./dist/types/index.d.ts",
    },
    scripts: {
      generate: "bun run src/codegen/generate-cli.ts",
      validate: "bun run src/validate-cli.ts",
      docs: "bun src/codegen/docs-cli.ts",
      prepack: "bun run generate && bun run validate",
    },
    dependencies: {
      "@intentius/chant": "workspace:*",
    },
    devDependencies: {
      typescript: "^5.9.3",
    },
  };

  return JSON.stringify(pkg, null, 2) + "\n";
}

function generateTsConfig(): string {
  const config = {
    extends: "../../tsconfig.json",
    compilerOptions: {
      rootDir: "./src",
      outDir: "./dist",
    },
    include: ["src/**/*"],
  };

  return JSON.stringify(config, null, 2) + "\n";
}

function generateJustfile(name: string): string {
  return `# Default recipe - list all available commands
default:
    @just --list

# Generate types and metadata from upstream schemas
generate:
    bun run src/codegen/generate-cli.ts

# Validate generated artifacts
validate:
    bun run src/validate-cli.ts

# Generate docs site, install deps, and start dev server
docs:
    bun run src/codegen/docs-cli.ts
    bun install --cwd docs
    bun --cwd docs dev

# Build docs site for production
docs-build:
    bun run src/codegen/docs-cli.ts
    bun install --cwd docs
    bun --cwd docs build

# Package the lexicon (generate + validate)
package: generate validate
`;
}

function generateGitignore(): string {
  return `.snapshots/
dist/
node_modules/
.cache/
`;
}

function generateReadme(name: string, names: ReturnType<typeof deriveNames>): string {
  return `# ${names.packageName}

${name} lexicon plugin for [chant](https://github.com/intentius/chant).

## Getting started

\`\`\`bash
# Generate types from upstream spec
just generate

# Validate generated artifacts
just validate

# Generate documentation
just docs
\`\`\`

## Project structure

- \`src/plugin.ts\` — LexiconPlugin with all lifecycle methods
- \`src/serializer.ts\` — Build output serializer
- \`src/codegen/\` — Code generation pipeline
- \`src/spec/\` — Upstream schema fetching and parsing
- \`src/lint/rules/\` — Lint rules
- \`src/lsp/\` — LSP completions and hover
- \`src/generated/\` — Generated artifacts (do not edit)
`;
}

// ── Docs site skeleton generators ────────────────────────────────────

function generateDocsPackageJson(name: string): string {
  return JSON.stringify(
    {
      name: `@intentius/chant-lexicon-${name}-docs`,
      type: "module",
      version: "0.0.1",
      private: true,
      scripts: {
        dev: "astro dev",
        build: "astro build",
        preview: "astro preview",
      },
      dependencies: {
        "@astrojs/starlight": "^0.37.6",
        astro: "^5.6.1",
        sharp: "^0.34.2",
      },
    },
    null,
    2,
  ) + "\n";
}

function generateDocsTsConfig(): string {
  return JSON.stringify(
    {
      extends: "astro/tsconfigs/strict",
      include: [".astro/types.d.ts", "**/*"],
      exclude: ["dist"],
    },
    null,
    2,
  ) + "\n";
}

function generateDocsAstroConfig(name: string): string {
  const displayName = name.charAt(0).toUpperCase() + name.slice(1);
  return `// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  integrations: [
    starlight({
      title: '${displayName}',
      sidebar: [
        { label: 'Overview', slug: '' },
      ],
    }),
  ],
});
`;
}

function generateDocsContentConfig(): string {
  return `import { defineCollection } from 'astro:content';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';

export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
};
`;
}

function generateDocsIndexMdx(name: string): string {
  const displayName = name.charAt(0).toUpperCase() + name.slice(1);
  return `---
title: Overview
description: ${displayName} lexicon for chant
---

Welcome to the ${displayName} lexicon documentation.

Run \`just generate\` to populate this site with generated reference pages.
`;
}

// ── Main command ─────────────────────────────────────────────────────

/**
 * Execute the init-lexicon command.
 */
export async function initLexiconCommand(options: InitLexiconOptions): Promise<InitLexiconResult> {
  const { name } = options;
  const names = deriveNames(name);
  const targetDir = resolve(options.path ?? join("lexicons", name));
  const createdFiles: string[] = [];
  const warnings: string[] = [];

  // Check if directory is non-empty
  if (existsSync(targetDir)) {
    const contents = readdirSync(targetDir);
    const nonHiddenFiles = contents.filter((f) => !f.startsWith("."));

    if (nonHiddenFiles.length > 0 && !options.force) {
      return {
        success: false,
        createdFiles: [],
        warnings: [],
        error: `Directory is not empty: ${targetDir}\nUse --force to initialize anyway.`,
      };
    }

    if (nonHiddenFiles.length > 0) {
      warnings.push("Initializing in non-empty directory");
    }
  }

  // Create directory structure
  const dirs = [
    "",
    "src",
    "src/codegen",
    "src/spec",
    "src/lint",
    "src/lint/rules",
    "src/lsp",
    "src/import",
    "src/generated",
    "docs",
    "docs/src",
    "docs/src/content",
    "docs/src/content/docs",
    "examples/getting-started",
    ".snapshots",
  ];

  for (const dir of dirs) {
    const fullPath = join(targetDir, dir);
    if (!existsSync(fullPath)) {
      mkdirSync(fullPath, { recursive: true });
    }
  }

  // File map: relative path -> content
  const files: Record<string, string> = {
    "src/plugin.ts": generatePluginTs(name, names),
    "src/index.ts": generateIndexTs(names),
    "src/serializer.ts": generateSerializerTs(name, names),
    "src/codegen/generate.ts": generateCodegenGenerateTs(),
    "src/codegen/generate-cli.ts": generateCodegenGenerateCliTs(),
    "src/codegen/naming.ts": generateCodegenNamingTs(),
    "src/codegen/package.ts": generateCodegenPackageTs(name),
    "src/codegen/rollback.ts": generateCodegenRollbackTs(),
    "src/codegen/docs.ts": generateCodegenDocsTs(name),
    "src/spec/fetch.ts": generateSpecFetchTs(),
    "src/spec/parse.ts": generateSpecParseTs(),
    "src/lint/rules/sample.ts": generateSampleRuleTs(names),
    "src/lint/rules/index.ts": generateLintRulesIndexTs(),
    "src/lsp/completions.ts": generateLspCompletionsTs(name),
    "src/lsp/hover.ts": generateLspHoverTs(name),
    "src/import/parser.ts": generateImportParserTs(name),
    "src/import/generator.ts": generateImportGeneratorTs(name),
    "src/coverage.ts": generateCoverageTs(name),
    "src/validate.ts": generateValidateTs(name),
    "src/validate-cli.ts": generateValidateCliTs(),
    "package.json": generatePackageJson(name, names),
    "tsconfig.json": generateTsConfig(),
    "justfile": generateJustfile(name),
    ".gitignore": generateGitignore(),
    "README.md": generateReadme(name, names),
    "docs/package.json": generateDocsPackageJson(name),
    "docs/tsconfig.json": generateDocsTsConfig(),
    "docs/astro.config.mjs": generateDocsAstroConfig(name),
    "docs/src/content.config.ts": generateDocsContentConfig(),
    "docs/src/content/docs/index.mdx": generateDocsIndexMdx(name),
  };

  // Write .gitkeep files
  const gitkeeps = [
    "src/generated/.gitkeep",
    "examples/getting-started/.gitkeep",
    ".snapshots/.gitkeep",
  ];

  for (const gk of gitkeeps) {
    const fullPath = join(targetDir, gk);
    if (!existsSync(fullPath)) {
      writeFileSync(fullPath, "");
      createdFiles.push(gk);
    }
  }

  // Write all template files
  for (const [relativePath, content] of Object.entries(files)) {
    writeIfNotExists(
      join(targetDir, relativePath),
      content,
      relativePath,
      createdFiles,
      warnings,
    );
  }

  return {
    success: true,
    createdFiles,
    warnings,
  };
}

/**
 * Print the result of init-lexicon and show next steps.
 */
export async function printInitLexiconResult(result: InitLexiconResult): Promise<void> {
  if (!result.success) {
    console.error(result.error);
    return;
  }

  for (const warning of result.warnings) {
    console.error(formatWarning({ message: warning }));
  }

  if (result.createdFiles.length > 0) {
    console.log(formatSuccess("Created:"));
    for (const file of result.createdFiles) {
      console.log(`  ${file}`);
    }
  }

  console.log("");
  console.log("Next steps:");
  console.log("  1. cd into the lexicon directory");
  console.log("  2. bun install");
  console.log("  3. Edit src/spec/fetch.ts — point at your upstream schema source");
  console.log("  4. Edit src/spec/parse.ts — parse your schema format");
  console.log("  5. just generate — generate types from spec");
  console.log("  6. just validate — check generated artifacts");
}
