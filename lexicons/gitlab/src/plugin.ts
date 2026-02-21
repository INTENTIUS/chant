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
        name: "chant-gitlab",
        description: "GitLab CI/CD pipeline management — workflows, patterns, and troubleshooting",
        content: `---
skill: chant-gitlab
description: Build, validate, and deploy GitLab CI pipelines from a chant project
user-invocable: true
---

# Deploying GitLab CI Pipelines from Chant

This project defines GitLab CI jobs as TypeScript in \`src/\`. Use these steps to build, validate, and deploy.

## Build the pipeline

\`\`\`bash
chant build src/ --output .gitlab-ci.yml
\`\`\`

## Validate before pushing

\`\`\`bash
chant lint src/
\`\`\`

For API-level validation against your GitLab instance:
\`\`\`bash
curl --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \\
  "https://gitlab.com/api/v4/ci/lint" \\
  --data "{\\"content\\": \\"$(cat .gitlab-ci.yml)\\"}"
\`\`\`

## Deploy

Commit and push the generated \`.gitlab-ci.yml\` — GitLab runs the pipeline automatically:

\`\`\`bash
chant build src/ --output .gitlab-ci.yml
git add .gitlab-ci.yml
git commit -m "Update pipeline"
git push
\`\`\`

## Check pipeline status

- GitLab UI: project → CI/CD → Pipelines
- API: \`curl --header "PRIVATE-TOKEN: $GITLAB_TOKEN" "https://gitlab.com/api/v4/projects/$PROJECT_ID/pipelines?per_page=5"\`

## Retry a failed job

- GitLab UI: click Retry on the failed job
- API: \`curl --request POST --header "PRIVATE-TOKEN: $GITLAB_TOKEN" "https://gitlab.com/api/v4/projects/$PROJECT_ID/jobs/$JOB_ID/retry"\`

## Cancel a running pipeline

- API: \`curl --request POST --header "PRIVATE-TOKEN: $GITLAB_TOKEN" "https://gitlab.com/api/v4/projects/$PROJECT_ID/pipelines/$PIPELINE_ID/cancel"\`

## Troubleshooting

- Check job logs in GitLab UI: project → CI/CD → Jobs → click the job
- \`chant lint src/\` catches: missing scripts (WGL002), deprecated only/except (WGL001), missing stages (WGL003), artifacts without expiry (WGL004)
- Post-synth checks (WGL010, WGL011) run during build
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
