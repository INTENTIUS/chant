/**
 * Project-level template generators for init-lexicon scaffold.
 */

export function generatePackageJson(name: string, names: { packageName: string }): string {
  const pkg = {
    name: names.packageName,
    version: "0.0.1",
    type: "module",
    private: true,
    files: ["src/", "dist/"],
    exports: {
      ".": {
        development: "./src/index.ts",
        types: "./dist/index.d.ts",
        default: "./src/index.ts",
      },
      "./*": {
        development: "./src/*.ts",
        types: "./dist/*.d.ts",
        default: "./src/*.ts",
      },
      "./manifest": "./dist/manifest.json",
      "./meta": "./dist/meta.json",
      "./types": "./dist/types/index.d.ts",
    },
    scripts: {
      generate: "npx tsx src/codegen/generate-cli.ts",
      validate: "npx tsx src/validate-cli.ts",
      docs: "npx tsx src/codegen/docs-cli.ts",
      build: 'tsc -p tsconfig.build.json && tsc-alias -p tsconfig.build.json && find dist -type f \\( -name "*.js" -o -name "*.js.map" \\) -delete',
      prepack: "npm run generate && npm run bundle && npm run validate && npm run build",
      bundle: "tsx src/package-cli.ts",
    },
    devDependencies: {
      // `*` (not `workspace:*`) so a fresh lexicon `npm install`s under plain npm
      // (the `workspace:` protocol is rejected outside a workspace).
      "@intentius/chant": "*",
      "tsc-alias": "^1.8.17",
      typescript: "^5.9.3",
    },
  };

  return JSON.stringify(pkg, null, 2) + "\n";
}

export function generateTsConfig(): string {
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

/**
 * Build config used by `npm run build` (and CI's `tsc --noEmit`). Uses `bundler`
 * resolution + the `development` condition so `@intentius/chant/*` resolves to the
 * workspace source, and excludes tests/docs — the same setup the shipped lexicons
 * use. (The plain `tsconfig.json` extends the monorepo root and can't be tsc'd on
 * its own.)
 */
export function generateTsConfigBuild(): string {
  const config = {
    extends: "../../tsconfig.json",
    compilerOptions: {
      noEmit: false,
      declaration: true,
      declarationMap: true,
      outDir: "dist",
      rootDir: "src",
      paths: {},
      moduleResolution: "bundler",
      customConditions: ["development"],
    },
    include: ["src/**/*"],
    exclude: ["**/*.test.ts", "node_modules", "dist", "docs"],
    "tsc-alias": { resolveFullPaths: true },
  };

  return JSON.stringify(config, null, 2) + "\n";
}

export function generateJustfile(name: string): string {
  return `# Default recipe - list all available commands
default:
    @just --list

# Generate types and metadata from upstream schemas
generate:
    npx tsx src/codegen/generate-cli.ts

# Validate generated artifacts
validate:
    npx tsx src/validate-cli.ts

# Generate docs site, install deps, and start dev server
docs:
    npx tsx src/codegen/docs-cli.ts
    npm install --prefix docs
    npm run --prefix docs dev

# Build docs site for production
docs-build:
    npx tsx src/codegen/docs-cli.ts
    npm install --prefix docs
    npm run --prefix docs build

# Package the lexicon (generate + validate)
package: generate validate
`;
}

export function generateGitignore(): string {
  return `dist/
node_modules/
.cache/
`;
}

export function generateReadme(name: string, names: { packageName: string }): string {
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

export function generateSerializerTs(name: string, names: { serializerVarName: string; rulePrefix: string }): string {
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

export function generateValidateTs(name: string): string {
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

export function generateValidateCliTs(): string {
  return `#!/usr/bin/env tsx
import { validate } from "./validate";

// \`validate\` takes an optional { basePath }; defaults to the lexicon root.
await validate();
`;
}

/**
 * Thin entry point for `npm run bundle`, called from `prepack`. Writes
 * `src/generated/` (via the generate pipeline) and `dist/` (via the package
 * pipeline plus `writeBundleSpec`), so `dist/manifest.json` exists before
 * `npm run validate` and `npm run build` run.
 */
export function generatePackageCliTs(): string {
  return `#!/usr/bin/env tsx
import { generate, writeGeneratedFiles } from "./codegen/generate";
import { packageLexicon } from "./codegen/package";
import { writeBundleSpec } from "@intentius/chant/codegen/package";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const srcDir = dirname(fileURLToPath(import.meta.url));

// 1. Generate src/generated/ files (writeGeneratedFiles resolves its own target)
const genResult = await generate({ verbose: true });
writeGeneratedFiles(genResult);

// 2. Run package pipeline and write dist/
const { spec, stats } = await packageLexicon({ verbose: true });

const distDir = join(dirname(srcDir), "dist");
writeBundleSpec(spec, distDir);

console.error(\`Packaged \${stats.resources} resources, \${stats.ruleCount} rules, \${stats.skillCount} skills\`);
console.error(\`dist/ written to \${distDir}\`);
`;
}
