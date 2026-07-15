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
      ".": "./src/index.ts",
      "./*": "./src/*",
      "./manifest": "./dist/manifest.json",
      "./meta": "./dist/meta.json",
      "./types": "./dist/types/index.d.ts",
    },
    scripts: {
      generate: "npx tsx src/codegen/generate-cli.ts",
      validate: "npx tsx src/validate-cli.ts",
      docs: "npx tsx src/codegen/docs-cli.ts",
      build: "tsc -p tsconfig.build.json && tsc-alias -p tsconfig.build.json",
      prepack: "npm run generate && npm run validate && npm run build",
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
