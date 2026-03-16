/**
 * GitLab CI/CD lexicon plugin.
 *
 * Provides serializer, template detection, and code generation
 * for GitLab CI/CD pipelines.
 */

import { createRequire } from "module";
import type { LexiconPlugin, IntrinsicDef, InitTemplateSet } from "@intentius/chant/lexicon";
const require = createRequire(import.meta.url);
import type { LintRule } from "@intentius/chant/lint/rule";
import { discoverPostSynthChecks } from "@intentius/chant/lint/discover";
import { createSkillsLoader, createDiffTool, createCatalogResource } from "@intentius/chant/lexicon-plugin-helpers";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
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

  postSynthChecks() {
    const postSynthDir = join(dirname(fileURLToPath(import.meta.url)), "lint", "post-synth");
    return discoverPostSynthChecks(postSynthDir, import.meta.url);
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

  initTemplates(template?: string): InitTemplateSet {
    if (template === "node-pipeline") {
      return {
        src: {
          "pipeline.ts": `import { NodePipeline } from "@intentius/chant-lexicon-gitlab";

export const app = NodePipeline({
  nodeVersion: "22",
  installCommand: "npm install",
  buildScript: "build",
  testScript: "test",
});
`,
        },
      };
    }

    if (template === "python-pipeline") {
      return {
        src: {
          "pipeline.ts": `import { PythonPipeline } from "@intentius/chant-lexicon-gitlab";

export const app = PythonPipeline({
  pythonVersion: "3.12",
  lintCommand: null,
});
`,
        },
      };
    }

    if (template === "docker-build") {
      return {
        src: {
          "pipeline.ts": `import { DockerBuild, Job, Image } from "@intentius/chant-lexicon-gitlab";

export const docker = DockerBuild({
  dockerfile: "Dockerfile",
  tagLatest: true,
});

export const test = new Job({
  stage: "test",
  image: new Image({ name: "node:22-alpine" }),
  script: ["node test.js"],
});
`,
        },
      };
    }

    if (template === "review-app") {
      return {
        src: {
          "pipeline.ts": `import { ReviewApp, Job, Image } from "@intentius/chant-lexicon-gitlab";

export const review = ReviewApp({
  name: "review",
  deployScript: "echo deploy",
});

export const test = new Job({
  stage: "test",
  image: new Image({ name: "node:22-alpine" }),
  script: ["node test.js"],
});
`,
        },
      };
    }

    // Default template — basic pipeline with shared config
    return {
      src: {
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
        "pipeline.ts": `import { Job, Artifacts } from "@intentius/chant-lexicon-gitlab";
import { defaultImage, npmCache } from "./config";

export const junitReports = { junit: "coverage/junit.xml" };

export const testArtifacts = new Artifacts({
  reports: junitReports,
  paths: ["coverage/"],
  expire_in: "1 week",
});

export const build = new Job({
  stage: "build",
  image: defaultImage,
  cache: npmCache,
  script: ["npm install", "npm run build"],
});

export const test = new Job({
  stage: "test",
  image: defaultImage,
  cache: npmCache,
  script: ["npm install", "npm test"],
  artifacts: testArtifacts,
});
`,
      },
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
    return [createDiffTool(gitlabSerializer, "Compare current build output against previous output for GitLab CI")];
  },

  mcpResources() {
    return [
      createCatalogResource(import.meta.url, "GitLab CI Entity Catalog", "JSON list of all supported GitLab CI entity types", "lexicon-gitlab.json"),
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

  skills: createSkillsLoader(import.meta.url, [
    {
      file: "chant-gitlab.md",
      name: "chant-gitlab",
      description: "GitLab CI/CD pipeline lifecycle — build, validate, deploy, monitor, rollback, and troubleshoot",
      triggers: [
        { type: "file-pattern", value: "**/*.gitlab.ts" },
        { type: "file-pattern", value: "**/.gitlab-ci.yml" },
        { type: "context", value: "gitlab" },
        { type: "context", value: "pipeline" },
        { type: "context", value: "deploy" },
      ],
      preConditions: [
        "chant CLI is installed (chant --version succeeds)",
        "git is configured and can push to the remote",
        "Project has chant source files in src/",
      ],
      postConditions: [
        "Pipeline is in a stable state (success/manual/scheduled)",
        "No failed jobs in the pipeline",
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
        {
          title: "Deploy pipeline update",
          description: "Build, validate, and deploy a pipeline change via MR workflow",
          input: "Deploy my pipeline changes to production",
          output: `chant lint src/
chant build src/ --output .gitlab-ci.yml
git checkout -b feature/pipeline-update
git add .gitlab-ci.yml
git commit -m "Update pipeline"
git push -u origin feature/pipeline-update
# Open MR in GitLab, review pipeline diff, then merge`,
        },
        {
          title: "Preview pipeline changes",
          description: "Validate pipeline configuration via lint and CI Lint API before deploying",
          input: "Check if my pipeline changes are valid before pushing",
          output: `chant lint src/
chant build src/ --output .gitlab-ci.yml
# Validate via GitLab CI Lint API
curl --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \\
  --header "Content-Type: application/json" \\
  "https://gitlab.com/api/v4/projects/$PROJECT_ID/ci/lint" \\
  --data-binary '{"content": "'$(cat .gitlab-ci.yml | jq -Rs .)'", "dry_run": true}'`,
        },
        {
          title: "Scaffold and deploy a Node.js pipeline",
          description: "Use --template to scaffold a Node.js project, build YAML, and push to GitLab",
          input: "Create a Node.js CI pipeline and deploy it to GitLab",
          output: `# Scaffold the project
chant init --lexicon gitlab --template node-pipeline my-node-app
cd my-node-app

# Build the YAML
chant build src/ --output .gitlab-ci.yml

# The GitLab repo needs app files — create them
echo '{"scripts":{"build":"echo build","test":"node test.js"}}' > package.json
echo 'console.log("ok")' > test.js

# Push to GitLab
git init -b main
git add .gitlab-ci.yml package.json test.js
git commit -m "Initial pipeline"
git remote add origin git@gitlab.com:YOUR_GROUP/YOUR_PROJECT.git
git push -u origin main`,
        },
        {
          title: "Retry a failed pipeline",
          description: "Retry a failed pipeline and monitor its progress",
          input: "Pipeline 12345 failed, retry it",
          output: `# Retry the pipeline
curl --request POST --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \\
  "https://gitlab.com/api/v4/projects/$PROJECT_ID/pipelines/12345/retry"
# Monitor status
curl --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \\
  "https://gitlab.com/api/v4/projects/$PROJECT_ID/pipelines/12345"`,
        },
      ],
    },
    {
      file: "chant-gitlab-patterns.md",
      name: "chant-gitlab-patterns",
      description: "GitLab CI/CD pipeline stages, caching, artifacts, includes, and advanced patterns",
      triggers: [
        { type: "context", value: "gitlab pipeline" },
        { type: "context", value: "gitlab cache" },
        { type: "context", value: "gitlab artifacts" },
        { type: "context", value: "gitlab include" },
        { type: "context", value: "gitlab stages" },
        { type: "context", value: "review app" },
      ],
      parameters: [],
      examples: [
        {
          title: "Pipeline with caching",
          input: "Set up a Node.js pipeline with proper caching",
          output: "import { Job, Cache } from \"@intentius/chant-lexicon-gitlab\";\n\nconst cache = new Cache({ key: { files: [\"package-lock.json\"] }, paths: [\"node_modules/\"] });",
        },
      ],
    },
  ]),
};
