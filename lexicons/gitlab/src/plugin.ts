/**
 * GitLab CI/CD lexicon plugin.
 *
 * Provides serializer, template detection, and code generation
 * for GitLab CI/CD pipelines.
 */

import { createRequire } from "module";
import type { LexiconPlugin, IntrinsicDef, SkillDefinition } from "@intentius/chant/lexicon";
const require = createRequire(import.meta.url);
import type { LintRule } from "@intentius/chant/lint/rule";
import type { PostSynthCheck } from "@intentius/chant/lint/post-synth";
import { gitlabSerializer } from "./serializer";

export const gitlabPlugin: LexiconPlugin = {
  name: "gitlab",
  serializer: gitlabSerializer,

  lintRules(): LintRule[] {
    const { deprecatedOnlyExceptRule } = require("./lint/rules/deprecated-only-except");
    const { missingScriptRule } = require("./lint/rules/missing-script");
    const { missingStageRule } = require("./lint/rules/missing-stage");
    const { artifactNoExpiryRule } = require("./lint/rules/artifact-no-expiry");
    return [deprecatedOnlyExceptRule, missingScriptRule, missingStageRule, artifactNoExpiryRule];
  },

  postSynthChecks(): PostSynthCheck[] {
    const { wgl010 } = require("./lint/post-synth/wgl010");
    const { wgl011 } = require("./lint/post-synth/wgl011");
    return [wgl010, wgl011];
  },

  intrinsics(): IntrinsicDef[] {
    return [
      {
        name: "reference",
        description: "!reference tag — reference another job's properties",
        outputKey: "!reference",
        isTag: true,
      },
    ];
  },

  initTemplates(): Record<string, string> {
    return {
      "config.ts": `/**
 * Shared pipeline configuration
 */

import { Image, Cache } from "@intentius/chant-lexicon-gitlab";

// Default image for all jobs
export const defaultImage = new Image({
  name: "node:20-alpine",
});

// Standard cache configuration
export const npmCache = new Cache({
  key: "$CI_COMMIT_REF_SLUG",
  paths: ["node_modules/"],
  policy: "pull-push",
});
`,
      "test.ts": `/**
 * Test job
 */

import { Job, Artifacts } from "@intentius/chant-lexicon-gitlab";
import { defaultImage, npmCache } from "./config";

export const test = new Job({
  stage: "test",
  image: defaultImage,
  cache: npmCache,
  script: ["npm ci", "npm test"],
  artifacts: new Artifacts({
    reports: { junit: "coverage/junit.xml" },
    paths: ["coverage/"],
    expireIn: "1 week",
  }),
});
`,
    };
  },

  detectTemplate(data: unknown): boolean {
    if (typeof data !== "object" || data === null) return false;
    const obj = data as Record<string, unknown>;

    // GitLab CI files typically have stages, or job-like top-level keys
    if (Array.isArray(obj.stages)) return true;
    if (obj.image !== undefined && obj.script !== undefined) return true;

    // Check for job-like entries (objects with "stage" or "script" properties)
    for (const value of Object.values(obj)) {
      if (typeof value === "object" && value !== null) {
        const entry = value as Record<string, unknown>;
        if (entry.stage !== undefined || entry.script !== undefined) {
          return true;
        }
      }
    }

    return false;
  },

  completionProvider(ctx: import("@intentius/chant/lsp/types").CompletionContext) {
    const { gitlabCompletions } = require("./lsp/completions");
    return gitlabCompletions(ctx);
  },

  hoverProvider(ctx: import("@intentius/chant/lsp/types").HoverContext) {
    const { gitlabHover } = require("./lsp/hover");
    return gitlabHover(ctx);
  },

  templateParser() {
    const { GitLabParser } = require("./import/parser");
    return new GitLabParser();
  },

  templateGenerator() {
    const { GitLabGenerator } = require("./import/generator");
    return new GitLabGenerator();
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
    const { analyzeGitLabCoverage } = await import("./coverage");
    await analyzeGitLabCoverage({
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
        description: "Compare current build output against previous output for GitLab CI",
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
            serializers: [gitlabSerializer],
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
        name: "GitLab CI Entity Catalog",
        description: "JSON list of all supported GitLab CI entity types",
        mimeType: "application/json",
        async handler(): Promise<string> {
          const lexicon = require("./generated/lexicon-gitlab.json") as Record<string, { resourceType: string; kind: string }>;
          const entries = Object.entries(lexicon).map(([className, entry]) => ({
            className,
            resourceType: entry.resourceType,
            kind: entry.kind,
          }));
          return JSON.stringify(entries);
        },
      },
      {
        uri: "examples/basic-pipeline",
        name: "Basic Pipeline Example",
        description: "A basic GitLab CI pipeline with build, test, and deploy stages",
        mimeType: "text/typescript",
        async handler(): Promise<string> {
          return `import { Job, Image, Cache, Artifacts, CI } from "@intentius/chant-lexicon-gitlab";

export const build = new Job({
  stage: "build",
  image: new Image({ name: "node:20" }),
  cache: new Cache({ key: CI.CommitRef, paths: ["node_modules/"] }),
  script: ["npm ci", "npm run build"],
  artifacts: new Artifacts({ paths: ["dist/"], expireIn: "1 day" }),
});

export const test = new Job({
  stage: "test",
  image: new Image({ name: "node:20" }),
  cache: new Cache({ key: CI.CommitRef, paths: ["node_modules/"], policy: "pull" }),
  script: ["npm ci", "npm test"],
  artifacts: new Artifacts({
    reports: { junit: "coverage/junit.xml" },
    expireIn: "1 week",
  }),
});

export const deploy = new Job({
  stage: "deploy",
  script: ["./deploy.sh"],
  rules: [{ if: "$CI_COMMIT_BRANCH == \\"main\\"", when: "manual" }],
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
    return [
      {
        name: "gitlab-ci",
        description: "GitLab CI/CD best practices and common patterns",
        content: `---
name: gitlab-ci
description: GitLab CI/CD best practices and common patterns
---

# GitLab CI/CD with Chant

## Common Entity Types

- \`Job\` — Pipeline job definition
- \`Default\` — Default settings inherited by all jobs
- \`Workflow\` — Pipeline-level configuration
- \`Artifacts\` — Job artifact configuration
- \`Cache\` — Cache configuration
- \`Image\` — Docker image for a job
- \`Rule\` — Conditional execution rule
- \`Environment\` — Deployment environment
- \`Trigger\` — Trigger downstream pipeline
- \`Include\` — Include external CI configuration

## Predefined Variables

- \`CI.CommitBranch\` — Current branch name
- \`CI.CommitSha\` — Current commit SHA
- \`CI.PipelineSource\` — What triggered the pipeline
- \`CI.ProjectPath\` — Project path (group/project)
- \`CI.Registry\` — Container registry URL
- \`CI.MergeRequestIid\` — MR internal ID

## Best Practices

1. **Use stages** — Organize jobs into logical stages (build, test, deploy)
2. **Cache dependencies** — Cache node_modules, pip packages, etc.
3. **Use rules** — Prefer \`rules:\` over \`only:/except:\` for conditional execution
4. **Minimize artifacts** — Only preserve files needed by later stages
5. **Use includes** — Share common configuration across projects
6. **Set timeouts** — Prevent stuck jobs from blocking pipelines
`,
        triggers: [
          { type: "file-pattern", value: "**/*.gitlab.ts" },
          { type: "context", value: "gitlab" },
        ],
        parameters: [],
        examples: [
          {
            title: "Basic test job",
            description: "Create a test job with caching and artifacts",
            input: "Create a test job",
            output: `new Job({
  stage: "test",
  image: new Image({ name: "node:20" }),
  script: ["npm ci", "npm test"],
  cache: new Cache({
    key: "$CI_COMMIT_REF_SLUG",
    paths: ["node_modules/"],
  }),
  artifacts: new Artifacts({
    reports: { junit: "coverage/junit.xml" },
  }),
})`,
          },
        ],
      },
    ];
  },
};
