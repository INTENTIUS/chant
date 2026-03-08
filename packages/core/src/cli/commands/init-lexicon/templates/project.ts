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

export function generateJustfile(name: string): string {
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
  return `#!/usr/bin/env bun
import { validate } from "./validate";

await validate({ verbose: true });
`;
}
