/**
 * GitLab CI/CD lexicon plugin.
 *
 * Provides serializer, template detection, and code generation
 * for GitLab CI/CD pipelines.
 */

import { createRequire } from "module";
import type { LexiconPlugin, IntrinsicDef, SkillDefinition, InitTemplateSet } from "@intentius/chant/lexicon";
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
    const { wgl012 } = require("./lint/post-synth/wgl012");
    const { wgl013 } = require("./lint/post-synth/wgl013");
    const { wgl014 } = require("./lint/post-synth/wgl014");
    const { wgl015 } = require("./lint/post-synth/wgl015");
    return [wgl010, wgl011, wgl012, wgl013, wgl014, wgl015];
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
    const skills: SkillDefinition[] = [
      {
        name: "chant-gitlab",
        description: "GitLab CI/CD pipeline lifecycle — build, validate, deploy, monitor, rollback, and troubleshoot",
        content: `---
skill: chant-gitlab
description: Build, validate, and deploy GitLab CI pipelines from a chant project
user-invocable: true
---

# GitLab CI/CD Operational Playbook

## How chant and GitLab CI relate

chant is a **synthesis-only** tool — it compiles TypeScript source files into \`.gitlab-ci.yml\` (YAML). chant does NOT call GitLab APIs. Your job as an agent is to bridge the two:

- Use **chant** for: build, lint, diff (local YAML comparison)
- Use **git + GitLab API** for: push, merge requests, pipeline monitoring, job logs, rollback, and all deployment operations

The source of truth for pipeline configuration is the TypeScript in \`src/\`. The generated \`.gitlab-ci.yml\` is an intermediate artifact — never edit it by hand.

## Scaffolding a new project

### Initialize with a template

\`\`\`bash
chant init --lexicon gitlab                           # default: config.ts + pipeline.ts
chant init --lexicon gitlab --template node-pipeline   # NodePipeline composite
chant init --lexicon gitlab --template python-pipeline # PythonPipeline composite
chant init --lexicon gitlab --template docker-build    # DockerBuild composite
chant init --lexicon gitlab --template review-app      # ReviewApp composite
\`\`\`

This creates \`src/\` with chant pipeline definitions. It does NOT create application files — you bring your own app code.

### Available templates

| Template | What it generates | Best for |
|----------|-------------------|----------|
| *(default)* | \`config.ts\` + \`pipeline.ts\` with build/test jobs | Custom pipelines from scratch |
| \`node-pipeline\` | \`NodePipeline\` composite with npm install/build/test | Node.js apps |
| \`python-pipeline\` | \`PythonPipeline\` composite with venv/pytest | Python apps |
| \`docker-build\` | \`DockerBuild\` composite + test job | Containerized apps |
| \`review-app\` | \`ReviewApp\` composite + test job | Apps needing per-MR environments |

## Deploying to GitLab

### What goes in the GitLab repo

The GitLab repo needs TWO things:
1. **\`.gitlab-ci.yml\`** — generated by \`chant build\`
2. **Your application files** — whatever the pipeline scripts reference

chant only generates the YAML. Application files (\`package.json\`, \`Dockerfile\`, \`requirements.txt\`, source code, tests) are your responsibility.

### Typical project structure in the GitLab repo

**Node.js project:**
\`\`\`
.gitlab-ci.yml      # generated by chant
package.json         # your app's package.json with build/test scripts
index.js             # your app code
test.js              # your tests
\`\`\`

**Python project:**
\`\`\`
.gitlab-ci.yml
requirements.txt     # must include pytest, pytest-cov if using PythonPipeline defaults
app.py
test_app.py
\`\`\`

**Docker project:**
\`\`\`
.gitlab-ci.yml
Dockerfile
src/                 # your app source
\`\`\`

### Important: npm ci vs npm install

The \`NodePipeline\` composite defaults to \`npm ci\`, which requires a \`package-lock.json\` in the repo. If your repo does not have a lockfile, override with:

\`\`\`typescript
NodePipeline({
  installCommand: "npm install",  // use instead of npm ci
  ...
})
\`\`\`

Or generate a lockfile: \`npm install && git add package-lock.json\`.

### Step-by-step: push to GitLab

\`\`\`bash
# 1. Build the YAML from chant source
chant build src/ --output .gitlab-ci.yml

# 2. Initialize git (if needed) and commit everything
git init -b main
git add .gitlab-ci.yml package.json index.js test.js  # add your app files
git commit -m "Initial pipeline"

# 3. Push to GitLab
git remote add origin git@gitlab.com:YOUR_GROUP/YOUR_PROJECT.git
git push -u origin main
\`\`\`

The pipeline triggers automatically on push. Do NOT commit the chant \`src/\` directory, \`node_modules/\`, or \`.chant/\` to the GitLab repo — those are local development files.

## Build and validate

### Build the pipeline

\`\`\`bash
chant build src/ --output .gitlab-ci.yml
\`\`\`

Options:
- \`--format yaml\` — emit YAML (default for GitLab)
- \`--watch\` — rebuild on source changes
- \`--output <path>\` — write to a specific file

### Lint the source

\`\`\`bash
chant lint src/
\`\`\`

Options:
- \`--fix\` — auto-fix violations where possible
- \`--format sarif\` — SARIF output for CI integration
- \`--watch\` — re-lint on changes

### Validate with GitLab CI Lint API

\`\`\`bash
curl --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \\
  --header "Content-Type: application/json" \\
  "https://gitlab.com/api/v4/projects/$PROJECT_ID/ci/lint" \\
  --data-binary @- <<EOF
{"content": $(cat .gitlab-ci.yml | jq -Rs .)}
EOF
\`\`\`

Add \`"dry_run": true, "include_merged_yaml": true\` for full expansion with includes resolved.

### What each step catches

| Step | Catches | When to run |
|------|---------|-------------|
| \`chant lint\` | Deprecated only/except (WGL001), missing script (WGL002), missing stage (WGL003), artifacts without expiry (WGL004) | Every edit |
| \`chant build\` | Post-synth checks: undefined stages (WGL010), unreachable jobs (WGL011), deprecated properties (WGL012), invalid needs targets (WGL013), invalid extends targets (WGL014), circular needs chains (WGL015) | Before push |
| CI Lint API | GitLab-specific validation: include resolution, variable expansion, YAML schema errors | Before merge to default branch |

Always run all three before deploying. Lint catches things the API cannot (and vice versa).

## Diffing and change preview

### Local diff

Compare generated \`.gitlab-ci.yml\` against the version on the remote branch:

\`\`\`bash
# Build the proposed config
chant build src/ --output .gitlab-ci.yml

# Diff against the remote version
git diff origin/main -- .gitlab-ci.yml
\`\`\`

### MR pipeline preview

Push to a branch and open a merge request — GitLab shows the pipeline that would run without executing it. This is the safest way to preview pipeline changes for production.

### CI Lint API with dry run

\`\`\`bash
curl --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \\
  --header "Content-Type: application/json" \\
  "https://gitlab.com/api/v4/projects/$PROJECT_ID/ci/lint" \\
  --data-binary @- <<EOF
{"content": $(cat .gitlab-ci.yml | jq -Rs .), "dry_run": true, "include_merged_yaml": true}
EOF
\`\`\`

This resolves all \`include:\` directives and expands the full pipeline — useful for catching issues with cross-file references.

### Safe preview checklist

Before merging pipeline changes, verify:
1. All jobs have valid \`stage:\` values and stages are defined
2. \`needs:\` references point to existing job names
3. \`rules:\` conditions match the intended branches/events
4. Environment names and \`on_stop\` references are correct
5. Docker images are accessible from your runners
6. Secrets/variables referenced in scripts exist in project settings

## Deploying pipeline changes

### Safe path (production pipelines)

1. Build: \`chant build src/ --output .gitlab-ci.yml\`
2. Lint: \`chant lint src/\`
3. Validate: CI Lint API (see above)
4. Push to feature branch: \`git push -u origin feature/pipeline-update\`
5. Open MR — review pipeline diff in the MR widget
6. Merge — pipeline runs on the default branch

### Fast path (dev/iteration)

\`\`\`bash
chant build src/ --output .gitlab-ci.yml
git add .gitlab-ci.yml && git commit -m "Update pipeline" && git push
\`\`\`

### Which path to use

| Scenario | Path |
|----------|------|
| Production pipeline with deploy jobs | Safe path (MR review) |
| Pipeline with environment/secrets changes | Safe path (MR review) |
| Dev/test pipeline iteration | Fast path (direct push) |
| CI/CD with approval gates or protected environments | Safe path + protected branch |

## Environment lifecycle

Environments are created by jobs with an \`environment:\` keyword. They track deployments and enable rollback.

### Review apps pattern

Deploy on MR, auto-stop when MR is merged or closed:

\`\`\`typescript
new Job({
  stage: "deploy",
  environment: new Environment({
    name: "review/$CI_COMMIT_REF_SLUG",
    url: "https://$CI_COMMIT_REF_SLUG.example.com",
    onStop: "stop_review",
    autoStopIn: "1 week",
  }),
  script: ["./deploy-review.sh"],
  rules: [{ if: "$CI_MERGE_REQUEST_IID" }],
});
\`\`\`

### Environment promotion

Deploy through environments in order: dev → staging → production. Use \`rules:\` and \`when: manual\` to gate promotions.

### Rollback to a previous deployment

\`\`\`bash
# List deployments for an environment
curl --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \\
  "https://gitlab.com/api/v4/projects/$PROJECT_ID/environments/$ENV_ID/deployments?order_by=created_at&sort=desc&per_page=5"

# Re-deploy a previous deployment's commit
curl --request POST --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \\
  "https://gitlab.com/api/v4/projects/$PROJECT_ID/deployments" \\
  --data "environment=production&sha=$PREVIOUS_SHA&ref=main&tag=false&status=created"
\`\`\`

Alternatively, revert the MR that introduced the change and let the pipeline re-run.

## Pipeline and job states

### Pipeline states

| State | Meaning | Action |
|-------|---------|--------|
| \`created\` | Pipeline created, not yet started | Wait |
| \`waiting_for_resource\` | Waiting for runner | Check runner availability |
| \`preparing\` | Job is being prepared | Wait |
| \`pending\` | Waiting for runner to pick up | Check runner tags/availability |
| \`running\` | Pipeline is executing | Monitor |
| \`success\` | All jobs passed | None — healthy |
| \`failed\` | One or more jobs failed | Check failed job logs |
| \`canceled\` | Pipeline was canceled | Re-run if needed |
| \`skipped\` | Pipeline was skipped by rules | Check rules configuration |
| \`manual\` | Pipeline waiting for manual action | Trigger manual job or cancel |
| \`scheduled\` | Waiting for scheduled time | Wait |

### Job states

| State | Meaning | Action |
|-------|---------|--------|
| \`created\` | Job created | Wait |
| \`pending\` | Waiting for runner | Check runner tags |
| \`running\` | Job executing | Monitor logs |
| \`success\` | Job passed | None |
| \`failed\` | Job failed | Read trace log |
| \`canceled\` | Job canceled | Re-run if needed |
| \`skipped\` | Job skipped by rules/needs | Check rules |
| \`manual\` | Waiting for manual trigger | Play or skip |
| \`allowed_failure\` | Failed but allowed | Review — may indicate flaky test |

## Monitoring pipelines

### Check pipeline status

\`\`\`bash
curl --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \\
  "https://gitlab.com/api/v4/projects/$PROJECT_ID/pipelines/$PIPELINE_ID"
\`\`\`

### List recent pipelines for a branch

\`\`\`bash
curl --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \\
  "https://gitlab.com/api/v4/projects/$PROJECT_ID/pipelines?ref=main&per_page=5"
\`\`\`

### Get jobs in a pipeline

\`\`\`bash
curl --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \\
  "https://gitlab.com/api/v4/projects/$PROJECT_ID/pipelines/$PIPELINE_ID/jobs"
\`\`\`

### Stream job logs

\`\`\`bash
curl --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \\
  "https://gitlab.com/api/v4/projects/$PROJECT_ID/jobs/$JOB_ID/trace"
\`\`\`

### Download job artifacts

\`\`\`bash
curl --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \\
  --output artifacts.zip \\
  "https://gitlab.com/api/v4/projects/$PROJECT_ID/jobs/$JOB_ID/artifacts"
\`\`\`

## Merge request pipeline workflow

### How MR pipelines differ

MR pipelines run in a merge request context with \`CI_MERGE_REQUEST_IID\` available. Branch pipelines run on push with \`CI_COMMIT_BRANCH\`. A job cannot have both — use \`rules:\` to target one or the other.

### Common rules patterns

\`\`\`yaml
# Run only on MR pipelines
rules:
  - if: $CI_MERGE_REQUEST_IID

# Run only on the default branch
rules:
  - if: $CI_COMMIT_BRANCH == "main"

# Run on MRs and the default branch (but not both at once)
rules:
  - if: $CI_MERGE_REQUEST_IID
  - if: $CI_COMMIT_BRANCH == "main"
\`\`\`

### Merged results pipelines

Enable in project settings → CI/CD → General pipelines → "Merged results pipelines". These test the result of merging your branch into the target — catching integration issues before merge.

### Merge trains

Merge trains queue MRs and test each one merged on top of the previous. Enable in project settings → Merge requests → "Merge trains". Requires merged results pipelines.

## Troubleshooting decision tree

### Step 1: Check pipeline status

\`\`\`bash
curl --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \\
  "https://gitlab.com/api/v4/projects/$PROJECT_ID/pipelines/$PIPELINE_ID" | jq '.status'
\`\`\`

### Step 2: Branch on status

- **\`running\` / \`pending\` / \`created\`** → Wait. Do not take action while the pipeline is in progress.
- **\`failed\`** → Read the failed job logs (Step 3).
- **\`success\`** → Pipeline is healthy. If behavior is wrong, check job scripts and configuration.
- **\`canceled\`** → Re-run if needed: \`curl --request POST ... /pipelines/$PIPELINE_ID/retry\`
- **\`skipped\`** → All jobs were filtered out by \`rules:\`. Check rule conditions.

### Step 3: Read failed job logs

\`\`\`bash
# Get failed jobs
curl --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \\
  "https://gitlab.com/api/v4/projects/$PROJECT_ID/pipelines/$PIPELINE_ID/jobs?scope=failed" | jq '.[].id'

# Read the trace for a failed job
curl --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \\
  "https://gitlab.com/api/v4/projects/$PROJECT_ID/jobs/$JOB_ID/trace"
\`\`\`

### Step 4: Diagnose by error pattern

| Error pattern | Likely cause | Fix |
|---------------|-------------|-----|
| "no matching runner" | No runner with matching tags | Check runner tags, register a runner |
| "image pull failed" | Docker image not found or auth failed | Check image name, registry credentials |
| "script exit code 1" | Script command failed | Read job log for the failing command |
| "artifact upload failed" | Artifact path doesn't exist or too large | Check \`artifacts.paths\`, size limits |
| "cache not found" | Cache key mismatch or first run | Expected on first run; check \`cache.key\` |
| "yaml invalid" | Syntax error in generated YAML | Run \`chant lint src/\` and CI Lint API |
| "pipeline filtered out" | All jobs filtered by rules | Check \`rules:\` conditions |
| "job timed out" | Job exceeded timeout | Increase \`timeout:\` or optimize job |
| "stuck or pending" | No available runner | Check runner status, tags, executor capacity |
| "environment does not exist" | \`on_stop\` references non-existent job | Check \`on_stop\` job name matches expanded name |
| "needs job not found" | \`needs:\` references non-existent job | Check job names, stage ordering |

## Variable management

### Variable types and precedence

Variables are resolved in this order (highest priority first):
1. Job-level \`variables:\`
2. Project CI/CD variables (Settings → CI/CD → Variables)
3. Group CI/CD variables
4. Instance CI/CD variables

### Protected and masked variables

- **Protected**: only available in pipelines on protected branches/tags
- **Masked**: hidden in job logs (value must meet masking requirements)

### Managing variables via API

\`\`\`bash
# List project variables
curl --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \\
  "https://gitlab.com/api/v4/projects/$PROJECT_ID/variables"

# Create a variable
curl --request POST --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \\
  "https://gitlab.com/api/v4/projects/$PROJECT_ID/variables" \\
  --form "key=DEPLOY_TOKEN" --form "value=secret" --form "masked=true" --form "protected=true"

# Update a variable
curl --request PUT --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \\
  "https://gitlab.com/api/v4/projects/$PROJECT_ID/variables/DEPLOY_TOKEN" \\
  --form "value=new-secret"

# Delete a variable
curl --request DELETE --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \\
  "https://gitlab.com/api/v4/projects/$PROJECT_ID/variables/DEPLOY_TOKEN"
\`\`\`

## Quick reference

### Pipeline info commands

\`\`\`bash
# List recent pipelines
curl --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \\
  "https://gitlab.com/api/v4/projects/$PROJECT_ID/pipelines?per_page=5"

# Get pipeline status
curl --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \\
  "https://gitlab.com/api/v4/projects/$PROJECT_ID/pipelines/$PIPELINE_ID"

# Get jobs in a pipeline
curl --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \\
  "https://gitlab.com/api/v4/projects/$PROJECT_ID/pipelines/$PIPELINE_ID/jobs"

# Read job log
curl --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \\
  "https://gitlab.com/api/v4/projects/$PROJECT_ID/jobs/$JOB_ID/trace"

# Retry a failed pipeline
curl --request POST --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \\
  "https://gitlab.com/api/v4/projects/$PROJECT_ID/pipelines/$PIPELINE_ID/retry"

# Cancel a running pipeline
curl --request POST --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \\
  "https://gitlab.com/api/v4/projects/$PROJECT_ID/pipelines/$PIPELINE_ID/cancel"
\`\`\`

### Full build-to-deploy pipeline

\`\`\`bash
# 1. Lint
chant lint src/

# 2. Build
chant build src/ --output .gitlab-ci.yml

# 3. Validate via API
curl --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \\
  --header "Content-Type: application/json" \\
  "https://gitlab.com/api/v4/projects/$PROJECT_ID/ci/lint" \\
  --data-binary @- <<EOF
{"content": $(cat .gitlab-ci.yml | jq -Rs .)}
EOF

# 4. Push to feature branch
git checkout -b feature/pipeline-update
git add .gitlab-ci.yml
git commit -m "Update pipeline"
git push -u origin feature/pipeline-update

# 5. Open MR, review pipeline diff, merge
# Pipeline runs automatically on the default branch after merge
\`\`\`
`,
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
    ];

    // Load file-based skills from src/skills/
    const { readFileSync } = require("fs");
    const { join, dirname } = require("path");
    const { fileURLToPath } = require("url");
    const dir = dirname(fileURLToPath(import.meta.url));

    const skillFiles = [
      {
        file: "gitlab-ci-patterns.md",
        name: "gitlab-ci-patterns",
        description: "GitLab CI/CD pipeline stages, caching, artifacts, includes, and advanced patterns",
        triggers: [
          { type: "context" as const, value: "gitlab pipeline" },
          { type: "context" as const, value: "gitlab cache" },
          { type: "context" as const, value: "gitlab artifacts" },
          { type: "context" as const, value: "gitlab include" },
          { type: "context" as const, value: "gitlab stages" },
          { type: "context" as const, value: "review app" },
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
