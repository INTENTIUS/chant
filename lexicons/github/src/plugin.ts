/**
 * GitHub Actions lexicon plugin.
 *
 * Provides serializer, template detection, and code generation
 * for GitHub Actions workflows.
 */

import type { LexiconPlugin, IntrinsicDef, InitTemplateSet } from "@intentius/chant/lexicon";
import type { LintRule } from "@intentius/chant/lint/rule";
import { discoverPostSynthChecks } from "@intentius/chant/lint/discover";
import { createSkillsLoader, createDiffTool, createCatalogResource } from "@intentius/chant/lexicon-plugin-helpers";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { githubSerializer } from "./serializer";
import { useTypedActionsRule } from "./lint/rules/use-typed-actions";
import { useConditionBuildersRule } from "./lint/rules/use-condition-builders";
import { noHardcodedSecretsRule } from "./lint/rules/no-hardcoded-secrets";
import { useMatrixBuilderRule } from "./lint/rules/use-matrix-builder";
import { extractInlineStructsRule } from "./lint/rules/extract-inline-structs";
import { fileJobLimitRule } from "./lint/rules/file-job-limit";
import { noRawExpressionsRule } from "./lint/rules/no-raw-expressions";
import { missingRecommendedInputsRule } from "./lint/rules/missing-recommended-inputs";
import { deprecatedActionVersionRule } from "./lint/rules/deprecated-action-version";
import { jobTimeoutRule } from "./lint/rules/job-timeout";
import { suggestCacheRule } from "./lint/rules/suggest-cache";
import { validateConcurrencyRule } from "./lint/rules/validate-concurrency";
import { detectSecretsRule } from "./lint/rules/detect-secrets";
import { githubCompletions } from "./lsp/completions";
import { githubHover } from "./lsp/hover";
import { GitHubActionsParser } from "./import/parser";
import { GitHubActionsGenerator } from "./import/generator";

export const githubPlugin: LexiconPlugin = {
  name: "github",
  serializer: githubSerializer,

  lintRules(): LintRule[] {
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

  postSynthChecks() {
    const postSynthDir = join(dirname(fileURLToPath(import.meta.url)), "lint", "post-synth");
    return discoverPostSynthChecks(postSynthDir, import.meta.url);
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
    return githubCompletions(ctx);
  },

  hoverProvider(ctx: import("@intentius/chant/lsp/types").HoverContext) {
    return githubHover(ctx);
  },

  templateParser() {
    return new GitHubActionsParser();
  },

  templateGenerator() {
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
    return [createDiffTool(githubSerializer, "Compare current build output against previous output for GitHub Actions")];
  },

  mcpResources() {
    return [
      createCatalogResource(import.meta.url, "GitHub Actions Entity Catalog", "JSON list of all supported GitHub Actions entity types", "lexicon-github.json"),
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

  skills: createSkillsLoader(import.meta.url, [
    {
      file: "chant-github.md",
      name: "chant-github",
      description: "GitHub Actions workflow lifecycle — build, validate, deploy",
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
    {
      file: "chant-github-patterns.md",
      name: "chant-github-patterns",
      description: "GitHub Actions workflow patterns — triggers, jobs, matrix, caching, artifacts",
      triggers: [
        { type: "context", value: "github actions" },
        { type: "context", value: "workflow" },
        { type: "context", value: "matrix" },
        { type: "context", value: "cache" },
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
    {
      file: "chant-github-security.md",
      name: "chant-github-security",
      description: "GitHub Actions security — secret scanning, OIDC, permissions hardening, supply chain",
      triggers: [
        { type: "context", value: "github security" },
        { type: "context", value: "workflow security" },
        { type: "context", value: "oidc" },
        { type: "context", value: "permissions" },
      ],
      parameters: [],
      examples: [
        {
          title: "Permissions hardening",
          input: "Lock down workflow permissions",
          output: `new Workflow({ permissions: { contents: "read" } })`,
        },
      ],
    },
  ]),
};
