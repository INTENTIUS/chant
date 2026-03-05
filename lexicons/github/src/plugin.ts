/**
 * GitHub Actions lexicon plugin.
 *
 * Provides serializer, template detection, and code generation
 * for GitHub Actions workflows.
 */

import { createRequire } from "module";
import type { LexiconPlugin, IntrinsicDef, SkillDefinition, InitTemplateSet } from "@intentius/chant/lexicon";
const require = createRequire(import.meta.url);
import type { LintRule } from "@intentius/chant/lint/rule";
import type { PostSynthCheck } from "@intentius/chant/lint/post-synth";
import { githubSerializer } from "./serializer";

export const githubPlugin: LexiconPlugin = {
  name: "github",
  serializer: githubSerializer,

  lintRules(): LintRule[] {
    const { useTypedActionsRule } = require("./lint/rules/use-typed-actions");
    const { useConditionBuildersRule } = require("./lint/rules/use-condition-builders");
    const { noHardcodedSecretsRule } = require("./lint/rules/no-hardcoded-secrets");
    const { useMatrixBuilderRule } = require("./lint/rules/use-matrix-builder");
    const { extractInlineStructsRule } = require("./lint/rules/extract-inline-structs");
    const { fileJobLimitRule } = require("./lint/rules/file-job-limit");
    const { noRawExpressionsRule } = require("./lint/rules/no-raw-expressions");
    const { missingRecommendedInputsRule } = require("./lint/rules/missing-recommended-inputs");
    const { deprecatedActionVersionRule } = require("./lint/rules/deprecated-action-version");
    const { jobTimeoutRule } = require("./lint/rules/job-timeout");
    const { suggestCacheRule } = require("./lint/rules/suggest-cache");
    const { validateConcurrencyRule } = require("./lint/rules/validate-concurrency");
    const { detectSecretsRule } = require("./lint/rules/detect-secrets");
    return [
      useTypedActionsRule,
      useConditionBuildersRule,
      noHardcodedSecretsRule,
      useMatrixBuilderRule,
      extractInlineStructsRule,
      fileJobLimitRule,
      noRawExpressionsRule,
      missingRecommendedInputsRule,
      deprecatedActionVersionRule,
      jobTimeoutRule,
      suggestCacheRule,
      validateConcurrencyRule,
      detectSecretsRule,
    ];
  },

  postSynthChecks(): PostSynthCheck[] {
    const { gha006 } = require("./lint/post-synth/gha006");
    const { gha009 } = require("./lint/post-synth/gha009");
    const { gha011 } = require("./lint/post-synth/gha011");
    const { gha017 } = require("./lint/post-synth/gha017");
    const { gha018 } = require("./lint/post-synth/gha018");
    const { gha019 } = require("./lint/post-synth/gha019");
    return [gha006, gha009, gha011, gha017, gha018, gha019];
  },

  intrinsics(): IntrinsicDef[] {
    return [
      {
        name: "expression",
        description: "${{ }} expression wrapper for GitHub Actions contexts",
        outputKey: "expression",
        isTag: false,
      },
    ];
  },

  initTemplates(template?: string): InitTemplateSet {
    if (template === "node-ci") {
      return {
        src: {
          "pipeline.ts": `import { NodeCI } from "@intentius/chant-lexicon-github";

export const app = NodeCI({
  nodeVersion: "22",
  installCommand: "npm ci",
  buildScript: "build",
  testScript: "test",
});
`,
        },
      };
    }

    if (template === "docker-build") {
      return {
        src: {
          "pipeline.ts": `import { Job, Step, Workflow, PushTrigger, Checkout } from "@intentius/chant-lexicon-github";

export const push = new PushTrigger({ branches: ["main"] });

export const workflow = new Workflow({
  name: "Docker Build",
  on: { push: { branches: ["main"] } },
});

export const build = new Job({
  "runs-on": "ubuntu-latest",
  steps: [
    Checkout({}).step,
    new Step({
      name: "Build and push",
      run: "docker build -t myapp .",
    }),
  ],
});
`,
        },
      };
    }

    // Default template
    return {
      src: {
        "pipeline.ts": `import { Workflow, Job, Step, Checkout, SetupNode } from "@intentius/chant-lexicon-github";

export const workflow = new Workflow({
  name: "CI",
  on: {
    push: { branches: ["main"] },
    pull_request: { branches: ["main"] },
  },
});

export const build = new Job({
  "runs-on": "ubuntu-latest",
  steps: [
    Checkout({}).step,
    SetupNode({ nodeVersion: "22", cache: "npm" }).step,
    new Step({ name: "Install", run: "npm ci" }),
    new Step({ name: "Build", run: "npm run build" }),
    new Step({ name: "Test", run: "npm test" }),
  ],
});
`,
      },
    };
  },

  detectTemplate(data: unknown): boolean {
    if (typeof data !== "object" || data === null) return false;
    const obj = data as Record<string, unknown>;

    // GitHub Actions workflows have `on:` + `jobs:` keys
    if (obj.on !== undefined && obj.jobs !== undefined) return true;

    // Check for job-like entries with runs-on
    for (const value of Object.values(obj)) {
      if (typeof value === "object" && value !== null) {
        const entry = value as Record<string, unknown>;
        if (entry["runs-on"] !== undefined || entry.steps !== undefined) {
          return true;
        }
      }
    }

    return false;
  },

  completionProvider(ctx: import("@intentius/chant/lsp/types").CompletionContext) {
    const { githubCompletions } = require("./lsp/completions");
    return githubCompletions(ctx);
  },

  hoverProvider(ctx: import("@intentius/chant/lsp/types").HoverContext) {
    const { githubHover } = require("./lsp/hover");
    return githubHover(ctx);
  },

  templateParser() {
    const { GitHubActionsParser } = require("./import/parser");
    return new GitHubActionsParser();
  },

  templateGenerator() {
    const { GitHubActionsGenerator } = require("./import/generator");
    return new GitHubActionsGenerator();
  },

  async generate(options?: { verbose?: boolean }): Promise<void> {
    const { generate, writeGeneratedFiles } = await import("./codegen/generate");
    const { dirname } = await import("path");
    const { fileURLToPath } = await import("url");

    const result = await generate({ verbose: options?.verbose ?? true });
    const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
    writeGeneratedFiles(result, pkgDir);

    console.error(
      `Generated ${result.resources} entities, ${result.properties} property types, ${result.enums} enums`,
    );
    if (result.warnings.length > 0) {
      console.error(`${result.warnings.length} warnings`);
    }
  },

  async validate(options?: { verbose?: boolean }): Promise<void> {
    const { validate } = await import("./validate");
    const { printValidationResult } = await import("@intentius/chant/codegen/validate");
    const result = await validate();
    printValidationResult(result);
  },

  async coverage(options?: { verbose?: boolean; minOverall?: number }): Promise<void> {
    const { analyzeGitHubCoverage } = await import("./coverage");
    await analyzeGitHubCoverage({
      verbose: options?.verbose,
      minOverall: options?.minOverall,
    });
  },

  async package(options?: { verbose?: boolean; force?: boolean }): Promise<void> {
    const { packageLexicon } = await import("./codegen/package");
    const { writeBundleSpec } = await import("@intentius/chant/codegen/package");
    const { join, dirname } = await import("path");
    const { fileURLToPath } = await import("url");

    const { spec, stats } = await packageLexicon({ verbose: options?.verbose, force: options?.force });

    const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
    const distDir = join(pkgDir, "dist");
    writeBundleSpec(spec, distDir);

    console.error(`Packaged ${stats.resources} entities, ${stats.ruleCount} rules, ${stats.skillCount} skills`);
  },

  mcpTools() {
    return [
      {
        name: "diff",
        description: "Compare current build output against previous output for GitHub Actions",
        inputSchema: {
          type: "object" as const,
          properties: {
            path: {
              type: "string",
              description: "Path to the infrastructure project directory",
            },
          },
        },
        async handler(params: Record<string, unknown>): Promise<unknown> {
          const { diffCommand } = await import("@intentius/chant/cli/commands/diff");
          const result = await diffCommand({
            path: (params.path as string) ?? ".",
            serializers: [githubSerializer],
          });
          return result;
        },
      },
    ];
  },

  mcpResources() {
    return [
      {
        uri: "resource-catalog",
        name: "GitHub Actions Entity Catalog",
        description: "JSON list of all supported GitHub Actions entity types",
        mimeType: "application/json",
        async handler(): Promise<string> {
          const lexicon = require("./generated/lexicon-github.json") as Record<string, { resourceType: string; kind: string }>;
          const entries = Object.entries(lexicon).map(([className, entry]) => ({
            className,
            resourceType: entry.resourceType,
            kind: entry.kind,
          }));
          return JSON.stringify(entries);
        },
      },
      {
        uri: "examples/basic-ci",
        name: "Basic CI Example",
        description: "A basic GitHub Actions CI workflow with build and test",
        mimeType: "text/typescript",
        async handler(): Promise<string> {
          return `import { Workflow, Job, Step, Checkout, SetupNode } from "@intentius/chant-lexicon-github";

export const workflow = new Workflow({
  name: "CI",
  on: {
    push: { branches: ["main"] },
    pull_request: { branches: ["main"] },
  },
  permissions: { contents: "read" },
});

export const build = new Job({
  "runs-on": "ubuntu-latest",
  steps: [
    Checkout({}).step,
    SetupNode({ nodeVersion: "22", cache: "npm" }).step,
    new Step({ name: "Install", run: "npm ci" }),
    new Step({ name: "Build", run: "npm run build" }),
    new Step({ name: "Test", run: "npm test" }),
  ],
});
`;
        },
      },
    ];
  },

  async docs(options?: { verbose?: boolean }): Promise<void> {
    const { generateDocs } = await import("./codegen/docs");
    await generateDocs(options);
  },

  skills(): SkillDefinition[] {
    const skills: SkillDefinition[] = [
      {
        name: "chant-github",
        description: "GitHub Actions workflow lifecycle — build, validate, deploy",
        content: `---
skill: chant-github
description: Build, validate, and deploy GitHub Actions workflows from a chant project
user-invocable: true
---

# GitHub Actions Operational Playbook

## How chant and GitHub Actions relate

chant is a **synthesis compiler** — it compiles TypeScript source files into \`.github/workflows/*.yml\` (YAML). \`chant build\` does not call GitHub APIs; synthesis is pure and deterministic.

- Use **chant** for: build, lint, diff (local YAML comparison)
- Use **git + GitHub** for: push, pull requests, workflow monitoring

## Build and validate

\`\`\`bash
chant build src/ --output .github/workflows/ci.yml
chant lint src/
\`\`\`

## Deploy

\`\`\`bash
git add .github/workflows/ci.yml
git commit -m "Update workflow"
git push
\`\`\`
`,
        triggers: [
          { type: "file-pattern", value: "**/*.github.ts" },
          { type: "file-pattern", value: "**/.github/workflows/*.yml" },
          { type: "context", value: "github actions" },
          { type: "context", value: "workflow" },
        ],
        parameters: [],
        examples: [
          {
            title: "Basic CI workflow",
            description: "Create a CI workflow with build and test",
            input: "Create a CI workflow",
            output: `new Workflow({ name: "CI", on: { push: { branches: ["main"] }, pull_request: { branches: ["main"] } } })`,
          },
        ],
      },
    ];

    // Load file-based skills
    const { readFileSync } = require("fs");
    const { join, dirname } = require("path");
    const { fileURLToPath } = require("url");
    const dir = dirname(fileURLToPath(import.meta.url));

    const skillFiles = [
      {
        file: "github-actions-patterns.md",
        name: "github-actions-patterns",
        description: "GitHub Actions workflow patterns — triggers, jobs, matrix, caching, artifacts",
        triggers: [
          { type: "context" as const, value: "github actions" },
          { type: "context" as const, value: "workflow" },
          { type: "context" as const, value: "matrix" },
          { type: "context" as const, value: "cache" },
        ],
        parameters: [],
        examples: [
          {
            title: "Matrix strategy",
            input: "Set up a Node.js matrix build",
            output: `new Strategy({ matrix: { "node-version": ["18", "20", "22"] } })`,
          },
        ],
      },
    ];

    for (const skill of skillFiles) {
      try {
        const content = readFileSync(join(dir, "skills", skill.file), "utf-8");
        skills.push({
          name: skill.name,
          description: skill.description,
          content,
          triggers: skill.triggers,
          parameters: skill.parameters,
          examples: skill.examples,
        });
      } catch { /* skip missing skills */ }
    }

    return skills;
  },
};
