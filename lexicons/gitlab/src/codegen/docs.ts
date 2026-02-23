/**
 * Documentation generation for GitLab CI lexicon.
 *
 * Generates Starlight MDX pages for CI entities using the core docs pipeline.
 */

import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { docsPipeline, writeDocsSite, type DocsConfig } from "@intentius/chant/codegen/docs";

/**
 * Extract service name from GitLab CI type: "GitLab::CI::Job" → "CI"
 */
function serviceFromType(resourceType: string): string {
  const parts = resourceType.split("::");
  return parts.length >= 2 ? parts[1] : "CI";
}

const overview = `The **GitLab CI/CD** lexicon provides typed constructors for GitLab CI pipeline
configuration. It covers jobs, workflow settings, artifacts, caching, images,
rules, environments, triggers, and more.

Install it with:

\`\`\`bash
npm install --save-dev @intentius/chant-lexicon-gitlab
\`\`\`

## Quick Start

{{file:docs-snippets/src/quickstart.ts}}

The lexicon provides **3 resources** (Job, Workflow, Default), **13 property types** (Image, Cache, Artifacts, Rule, Environment, Trigger, and more), the \`CI\` pseudo-parameter object for predefined variables, and the \`reference()\` intrinsic for YAML \`!reference\` tags.
`;

const outputFormat = `The GitLab lexicon serializes resources into **\`.gitlab-ci.yml\` YAML**. Keys are
converted to \`snake_case\` and jobs use kebab-case names. Stages are automatically
collected from all job definitions.

## Building

Run \`chant build\` to produce a \`.gitlab-ci.yml\` from your declarations:

\`\`\`bash
chant build
# Writes dist/.gitlab-ci.yml
\`\`\`

The generated file includes:

- \`stages:\` list — automatically collected from all job \`stage\` properties
- \`default:\` section — if a \`Default\` resource is exported
- \`workflow:\` section — if a \`Workflow\` resource is exported
- Job definitions with \`snake_case\` keys and \`kebab-case\` job names

## Key conversions

| Chant (TypeScript) | YAML output | Rule |
|--------------------|-------------|------|
| \`export const buildApp = new Job({...})\` | \`build-app:\` | Export name → kebab-case job key |
| \`expire_in: "1 week"\` | \`expire_in: 1 week\` | Property names use spec-native snake_case |
| \`new Image({ name: "node:20" })\` | \`image: node:20\` | Single-property objects are collapsed |

## Validating locally

The output is standard GitLab CI YAML. Validate with the GitLab CI Lint API or locally:

\`\`\`bash
# Using the GitLab API
curl --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \\
  --data-urlencode "content=$(cat dist/.gitlab-ci.yml)" \\
  "https://gitlab.com/api/v4/ci/lint"

# Using the glab CLI
glab ci lint dist/.gitlab-ci.yml
\`\`\`

## Compatibility

The output is compatible with:
- GitLab CI/CD (any recent GitLab version)
- GitLab CI Lint API
- \`glab\` CLI tool
- Any tool that processes \`.gitlab-ci.yml\` files`;

/**
 * Generate documentation for the GitLab CI lexicon.
 */
export async function generateDocs(opts?: { verbose?: boolean }): Promise<void> {
  const pkgDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

  const config: DocsConfig = {
    name: "gitlab",
    displayName: "GitLab CI/CD",
    description: "Typed constructors for GitLab CI/CD pipeline configuration",
    distDir: join(pkgDir, "dist"),
    outDir: join(pkgDir, "docs"),
    overview,
    outputFormat,
    serviceFromType,
    suppressPages: ["intrinsics", "rules"],
    examplesDir: join(pkgDir, "examples"),
    extraPages: [
      {
        slug: "pipeline-concepts",
        title: "Pipeline Concepts",
        description: "Jobs, stages, artifacts, caching, images, rules, environments, and triggers in the GitLab CI/CD lexicon",
        content: `Every exported \`Job\` declaration becomes a job entry in the generated \`.gitlab-ci.yml\`. The serializer handles the translation automatically:

- Property names use spec-native snake_case (\`expire_in\`, \`allow_failure\`)
- Converts export names to kebab-case job keys (\`buildApp\` → \`build-app\`)
- Collects stages from all jobs into a \`stages:\` list
- Collapses single-property objects (\`new Image({ name: "node:20" })\` → \`image: node:20\`)

{{file:docs-snippets/src/job-basic.ts}}

Produces this YAML:

\`\`\`yaml
stages:
  - build

build-app:
  stage: build
  image: node:20
  script:
    - npm ci
    - npm run build
\`\`\`

## Resource types

The lexicon provides 3 resource types and 13 property types:

### Resources

| Type | Description |
|------|-------------|
| \`Job\` | A CI/CD job — the fundamental unit of a pipeline |
| \`Workflow\` | Top-level \`workflow:\` configuration (pipeline-level rules, name, auto_cancel) |
| \`Default\` | Top-level \`default:\` block (shared defaults inherited by all jobs) |

### Property types

| Type | Used in | Description |
|------|---------|-------------|
| \`Image\` | Job, Default | Docker image for the job runner |
| \`Cache\` | Job, Default | Files cached between pipeline runs |
| \`Artifacts\` | Job | Files passed between stages or stored after completion |
| \`Rule\` | Job, Workflow | Conditional execution rules (\`rules:\` entries) |
| \`Environment\` | Job | Deployment target environment |
| \`Trigger\` | Job | Downstream pipeline trigger |
| \`Include\` | Workflow | External YAML file inclusion |
| \`AllowFailure\` | Job | Failure tolerance configuration |
| \`Retry\` | Job | Automatic retry on failure |
| \`Parallel\` | Job | Job parallelization (matrix builds) |
| \`Release\` | Job | GitLab Release creation |
| \`AutoCancel\` | Workflow | Pipeline auto-cancellation settings |

## Shared config

Extract reusable objects into a shared config file and import them across your pipeline files:

{{file:docs-snippets/src/pipeline-shared-config.ts}}

## Jobs

A \`Job\` is the fundamental unit. Every exported \`Job\` becomes a job entry in the YAML:

{{file:docs-snippets/src/job-test.ts}}

Key properties:
- \`script\` — **required** (or \`trigger\`/\`run\`). Array of shell commands to execute.
- \`stage\` — which pipeline stage this job belongs to. Defaults to \`test\` if omitted.
- \`image\` — Docker image. Use \`new Image({ name: "..." })\` or pass a string to the YAML.
- \`needs\` — job dependencies for DAG-mode execution (run before stage ordering).

## Stages

Stages define the execution order of a pipeline. The serializer automatically collects unique stage values from all jobs:

{{file:docs-snippets/src/stages.ts}}

Produces:

\`\`\`yaml
stages:
  - test
  - build
  - deploy
\`\`\`

Jobs in the same stage run in parallel. Stages run sequentially in declaration order.

## Artifacts and caching

**Artifacts** are files produced by a job and passed to later stages or stored for download. **Caches** persist files between pipeline runs to speed up builds. Both are shown in the shared config:

{{file:docs-snippets/src/config.ts:4-22}}

The key difference: artifacts are for passing files between **stages in the same pipeline**; caches are for speeding up **repeated pipeline runs**.

## Conditional execution with rules

\`Rule\` objects control when a job runs. They map to \`rules:\` entries in the YAML:

{{file:docs-snippets/src/rules-conditions.ts}}

Produces:

\`\`\`yaml
deploy:
  stage: deploy
  script:
    - npm run deploy
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
      when: manual
\`\`\`

The \`ifCondition\` property maps to \`if:\` in the YAML (since \`if\` is a reserved word in TypeScript).

## Environments

\`Environment\` defines a deployment target:

{{file:docs-snippets/src/environment.ts}}

GitLab tracks deployments to environments and provides rollback capabilities in the UI.

## Images and services

\`Image\` specifies the Docker image for a job:

{{file:docs-snippets/src/images.ts}}

## Workflow

\`Workflow\` controls pipeline-level settings — when pipelines run, auto-cancellation, and global includes:

{{file:docs-snippets/src/workflow.ts}}

## Default

\`Default\` sets shared configuration inherited by all jobs:

{{file:docs-snippets/src/defaults.ts}}

Jobs can override any default property individually.

## Triggers

\`Trigger\` creates downstream pipeline jobs:

{{file:docs-snippets/src/trigger.ts}}`,
      },
      {
        slug: "variables",
        title: "Predefined Variables",
        description: "GitLab CI/CD predefined variable references",
        content: `The \`CI\` object provides type-safe access to GitLab CI/CD predefined variables. These map to \`$CI_*\` environment variables at runtime.

{{file:docs-snippets/src/variables-usage.ts}}

## Variable reference

| Property | Variable | Description |
|----------|----------|-------------|
| \`CI.CommitBranch\` | \`$CI_COMMIT_BRANCH\` | Current branch name (not set for tag pipelines) |
| \`CI.CommitRef\` | \`$CI_COMMIT_REF_NAME\` | Branch or tag name |
| \`CI.CommitSha\` | \`$CI_COMMIT_SHA\` | Full commit SHA |
| \`CI.CommitTag\` | \`$CI_COMMIT_TAG\` | Tag name (only set for tag pipelines) |
| \`CI.DefaultBranch\` | \`$CI_DEFAULT_BRANCH\` | Default branch (usually \`main\`) |
| \`CI.Environment\` | \`$CI_ENVIRONMENT_NAME\` | Environment name (set during deploy jobs) |
| \`CI.JobId\` | \`$CI_JOB_ID\` | Unique job ID |
| \`CI.JobName\` | \`$CI_JOB_NAME\` | Job name |
| \`CI.JobStage\` | \`$CI_JOB_STAGE\` | Job stage name |
| \`CI.MergeRequestIid\` | \`$CI_MERGE_REQUEST_IID\` | MR internal ID (merge request pipelines only) |
| \`CI.PipelineId\` | \`$CI_PIPELINE_ID\` | Unique pipeline ID |
| \`CI.PipelineSource\` | \`$CI_PIPELINE_SOURCE\` | How the pipeline was triggered (\`push\`, \`merge_request_event\`, \`schedule\`, etc.) |
| \`CI.ProjectDir\` | \`$CI_PROJECT_DIR\` | Full path of the repository clone |
| \`CI.ProjectId\` | \`$CI_PROJECT_ID\` | Unique project ID |
| \`CI.ProjectName\` | \`$CI_PROJECT_NAME\` | Project name (URL-safe) |
| \`CI.ProjectPath\` | \`$CI_PROJECT_PATH\` | Project namespace with project name |
| \`CI.Registry\` | \`$CI_REGISTRY\` | Container registry URL |
| \`CI.RegistryImage\` | \`$CI_REGISTRY_IMAGE\` | Registry image path for the project |

## Common patterns

{{file:docs-snippets/src/variables-patterns.ts}}
`,
      },
      {
        slug: "intrinsics",
        title: "Intrinsic Functions",
        description: "GitLab CI/CD intrinsic functions and their chant syntax",
        content: `The GitLab lexicon provides one intrinsic function: \`reference()\`, which maps to GitLab's \`!reference\` YAML tag.

## \`reference()\` — reuse job properties

The \`reference()\` intrinsic lets you reuse properties from other jobs or hidden keys. It produces the \`!reference\` YAML tag:

{{file:docs-snippets/src/reference-basic.ts}}

Serializes to:

\`\`\`yaml
deploy:
  script: !reference [.setup, script]
\`\`\`

### Syntax

\`\`\`typescript
reference(jobName: string, property: string): ReferenceTag
\`\`\`

- \`jobName\` — the job or hidden key to reference (e.g. \`".setup"\`, \`"build"\`)
- \`property\` — the property to extract (e.g. \`"script"\`, \`"before_script"\`, \`"rules"\`)

### Use cases

{{file:docs-snippets/src/reference-shared.ts}}

Produces:

\`\`\`yaml
test:
  stage: test
  before_script: !reference [.node-setup, before_script]
  script:
    - npm test

lint:
  stage: test
  before_script: !reference [.node-setup, before_script]
  script:
    - npm run lint
\`\`\`

### When to use \`reference()\` vs direct imports

{{file:docs-snippets/src/reference-vs-import.ts}}
`,
      },
      {
        slug: "lint-rules",
        title: "Lint Rules",
        description: "Built-in lint rules and post-synth checks for GitLab CI/CD",
        content: `The GitLab lexicon ships lint rules that run during \`chant lint\` and post-synth checks that validate the serialized YAML after \`chant build\`.

## Lint rules

Lint rules analyze your TypeScript source code before build.

### WGL001 — Deprecated only/except

**Severity:** warning | **Category:** style

Flags usage of \`only:\` and \`except:\` keywords, which are deprecated in favor of \`rules:\`. The \`rules:\` syntax is more flexible and is the recommended approach.

{{file:docs-snippets/src/lint-wgl001.ts}}

### WGL002 — Missing script

**Severity:** error | **Category:** correctness

A GitLab CI job must have \`script\`, \`trigger\`, or \`run\` defined. Jobs without any of these will fail pipeline validation.

{{file:docs-snippets/src/lint-wgl002.ts}}

### WGL003 — Missing stage

**Severity:** info | **Category:** style

Jobs should declare a \`stage\` property. Without it, the job defaults to the \`test\` stage, which may not be the intended behavior.

{{file:docs-snippets/src/lint-wgl003.ts}}

### WGL004 — Artifacts without expiry

**Severity:** warning | **Category:** performance

Flags \`Artifacts\` without \`expireIn\`. Artifacts without expiry are kept indefinitely, consuming storage. Always set an expiration.

{{file:docs-snippets/src/lint-wgl004.ts}}

## Post-synth checks

Post-synth checks run against the serialized YAML after build. They catch issues only visible in the final output.

### WGL010 — Undefined stage

**Severity:** error

Flags jobs that reference a stage not present in the collected stages list. This causes a pipeline validation error in GitLab.

### WGL011 — Unreachable job

**Severity:** warning

Flags jobs where all \`rules:\` entries have \`when: "never"\`, making the job unreachable. This usually indicates a configuration error.

{{file:docs-snippets/src/lint-wgl011.ts}}

### WGL012 — Deprecated property usage

**Severity:** warning

Flags properties marked as deprecated in the GitLab CI schema. Deprecation signals are mined from property descriptions (keywords like "deprecated", "legacy", "no longer available"). Using deprecated properties may cause unexpected behavior in future GitLab versions.

### WGL013 — Invalid \`needs:\` target

**Severity:** error

Flags jobs whose \`needs:\` entries reference a job not defined in the pipeline, or reference themselves. Both cause GitLab pipeline validation failures. When \`include:\` is present, the check is skipped since needed jobs may come from included files.

### WGL014 — Invalid \`extends:\` target

**Severity:** error

Flags jobs whose \`extends:\` references a template or hidden job not defined in the pipeline. GitLab rejects pipelines with unresolved extends references. When \`include:\` is present, the check is skipped since templates may come from included files.

### WGL015 — Circular \`needs:\` chain

**Severity:** error

Detects cycles in the \`needs:\` dependency graph. If job A needs B and B needs A (directly or transitively), GitLab rejects the pipeline. Reports the full cycle chain in the diagnostic message.

## Running lint

\`\`\`bash
# Lint your chant project
chant lint

# Lint with auto-fix where supported
chant lint --fix
\`\`\`

To suppress a rule on a specific line:

\`\`\`typescript
// chant-disable-next-line WGL001
export const deploy = new Job({ only: ["main"], script: ["deploy"] });
\`\`\`

To suppress globally in \`chant.config.ts\`:

\`\`\`typescript
export default {
  lint: {
    rules: {
      WGL003: "off",
    },
  },
};
\`\`\`
`,
      },
      {
        slug: "examples",
        title: "Examples",
        description: "Walkthrough of GitLab CI/CD examples — pipelines, composites, and cross-lexicon patterns",
        content: `Runnable examples live in the lexicon's \`examples/\` directory. Clone the repo and try them:

\`\`\`bash
cd examples/getting-started
bun install
chant build    # produces .gitlab-ci.yml
chant lint     # runs lint rules
bun test       # runs the example's tests
\`\`\`

## Getting Started

\`examples/getting-started/\` — a 3-stage Node.js pipeline with build, test, and deploy jobs.

\`\`\`
src/
├── config.ts      # Shared config: images, caches, artifacts, rules, environments
└── pipeline.ts    # Job definitions: build, test, deploy
\`\`\`

### Shared configuration

\`config.ts\` extracts reusable objects — images, caches, artifacts, rules, and environments — so jobs stay concise:

{{file:getting-started/src/config.ts}}

### Pipeline jobs

\`pipeline.ts\` defines three jobs that import shared config directly:

{{file:getting-started/src/pipeline.ts}}

### Generated output

\`chant build\` produces this \`.gitlab-ci.yml\`:

\`\`\`yaml
stages:
  - build
  - test
  - deploy

build:
  stage: build
  image: node:20-alpine
  cache:
    key: $CI_COMMIT_REF_SLUG
    paths:
      - node_modules/
    policy: pull-push
  script:
    - npm ci
    - npm run build
  artifacts:
    paths:
      - dist/
    expire_in: 1 hour

test:
  stage: test
  image: node:20-alpine
  cache:
    key: $CI_COMMIT_REF_SLUG
    paths:
      - node_modules/
    policy: pull-push
  script:
    - npm ci
    - npm test
  artifacts:
    paths:
      - coverage/
    expire_in: 1 week
    reports:
      junit: coverage/junit.xml
  rules:
    - if: $CI_MERGE_REQUEST_IID
    - if: $CI_COMMIT_BRANCH

deploy:
  stage: deploy
  image: node:20-alpine
  script:
    - npm run deploy
  environment:
    name: production
    url: https://example.com
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
      when: manual
\`\`\`

**Patterns demonstrated:**

1. **Shared config** — reusable images, caches, artifacts, and rules extracted into \`config.ts\`
2. **Conditional execution** — merge request and branch rules control when jobs run
3. **Manual deployment** — deploy requires manual trigger on the default branch
4. **JUnit reports** — test artifacts include JUnit XML for GitLab MR display

## Docker Build

\`examples/docker-build/\` — builds and pushes a Docker image using the \`DockerBuild\` composite.

{{file:docker-build/src/pipeline.ts}}

The \`DockerBuild\` composite expands to a job with Docker-in-Docker service, registry login, build, and push steps.

## Node Pipeline

\`examples/node-pipeline/\` — a full Node.js CI pipeline using the \`NodePipeline\` composite.

{{file:node-pipeline/src/pipeline.ts}}

## Python Pipeline

\`examples/python-pipeline/\` — a Python CI pipeline using the \`PythonPipeline\` composite.

{{file:python-pipeline/src/pipeline.ts}}

## Review App

\`examples/review-app/\` — deploys a review environment per merge request using the \`ReviewApp\` composite.

{{file:review-app/src/pipeline.ts}}

## AWS ALB Deployment

A cross-lexicon example showing how to deploy AWS CloudFormation stacks from GitLab CI. Three separate pipelines mirror the separate-project AWS ALB pattern:

### Infra pipeline

Deploys the shared ALB stack (VPC, ALB, ECS cluster, ECR repos):

\`\`\`typescript
import { Job, Image, Rule } from "@intentius/chant-lexicon-gitlab";

const awsImage = new Image({ name: "amazon/aws-cli:latest" });

export const deployInfra = new Job({
  stage: "deploy",
  image: awsImage,
  script: [
    "aws cloudformation deploy --template-file templates/template.json --stack-name shared-alb --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset",
  ],
  rules: [
    new Rule({ if: "$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH" }),
  ],
});
\`\`\`

### Service pipeline (API)

Builds a Docker image, pushes to ECR, and deploys the API service stack with cross-stack parameter passing:

\`\`\`typescript
import { Job, Image, Service, Need, Rule } from "@intentius/chant-lexicon-gitlab";
import { CI } from "@intentius/chant-lexicon-gitlab";

const ECR_URL = "$AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com";
const ECR_REPO = "alb-api";
const fullImage = \\\`\\\${ECR_URL}/\\\${ECR_REPO}\\\`;

const dockerImage = new Image({ name: "docker:27-cli" });
const dind = new Service({ name: "docker:27-dind", alias: "docker" });

export const buildImage = new Job({
  stage: "build",
  image: dockerImage,
  services: [dind],
  variables: { DOCKER_TLS_CERTDIR: "/certs" },
  before_script: [
    "apk add --no-cache aws-cli",
    \\\`aws ecr get-login-password | docker login --username AWS --password-stdin \\\${ECR_URL}\\\`,
  ],
  script: [
    \\\`docker build -t \\\${fullImage}:\\\${CI.CommitRefSlug} .\\\`,
    \\\`docker push \\\${fullImage}:\\\${CI.CommitRefSlug}\\\`,
  ],
  rules: [new Rule({ if: "$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH" })],
});

export const deployService = new Job({
  stage: "deploy",
  image: new Image({ name: "amazon/aws-cli:latest" }),
  needs: [new Need({ job: "build-image" })],
  script: [
    // Fetch shared ALB outputs and map to CF parameter overrides
    "OUTPUTS=$(aws cloudformation describe-stacks --stack-name shared-alb --query 'Stacks[0].Outputs' --output json)",
    'PARAMS=$(echo "$OUTPUTS" | jq -r \\'[...output-to-param mapping...] | join(" ")\\')',
    "aws cloudformation deploy --template-file templates/template.json --stack-name shared-alb-api --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset --parameter-overrides $PARAMS",
  ],
  rules: [new Rule({ if: "$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH" })],
});
\`\`\`

**Key patterns:**

1. **ECR login** — uses \`aws ecr get-login-password\` instead of GitLab registry credentials
2. **Cross-stack parameter passing** — \`describe-stacks\` fetches outputs from the infra stack, \`jq\` maps them to \`--parameter-overrides\`
3. **Job naming** — \`buildImage\` serializes to \`build-image\` in YAML; \`Need\` references must use kebab-case
4. **Docker-in-Docker** — \`docker:27-cli\` image with \`docker:27-dind\` service for container builds

The full examples live in \`examples/gitlab-aws-alb-infra/\`, \`examples/gitlab-aws-alb-api/\`, and \`examples/gitlab-aws-alb-ui/\`.
`,
      },
      {
        slug: "skills",
        title: "AI Skills",
        description: "AI agent skills bundled with the GitLab CI/CD lexicon",
        content: `The GitLab lexicon ships an AI skill called **chant-gitlab** that teaches AI coding agents (like Claude Code) how to build, validate, and deploy GitLab CI pipelines from a chant project.

## What are skills?

Skills are structured markdown documents bundled with a lexicon. When an AI agent works in a chant project, it discovers and loads relevant skills automatically — giving it operational knowledge about the deployment workflow without requiring the user to explain each step.

## Installation

When you scaffold a new project with \`chant init --lexicon gitlab\`, the skill is installed to \`.claude/skills/chant-gitlab/SKILL.md\` for automatic discovery by Claude Code.

For existing projects, create the file manually:

\`\`\`
.claude/
  skills/
    chant-gitlab/
      SKILL.md    # skill content (see below)
\`\`\`

## Skill: chant-gitlab

The \`chant-gitlab\` skill covers the full deployment lifecycle:

- **Build** — \`chant build src/ --output .gitlab-ci.yml\`
- **Validate** — \`chant lint src/\` + GitLab CI Lint API
- **Deploy** — commit and push the generated YAML
- **Status** — GitLab UI or pipelines API
- **Retry** — retry failed jobs via UI or API
- **Cancel** — cancel running pipelines via API
- **Troubleshooting** — job logs, lint rule codes (WGL001–WGL004), post-synth checks (WGL010–WGL015)

The skill is invocable as a slash command: \`/chant-gitlab\`

## MCP integration

The lexicon also provides MCP (Model Context Protocol) tools and resources that AI agents can use programmatically:

| MCP tool | Description |
|----------|-------------|
| \`build\` | Build the chant project |
| \`lint\` | Run lint rules |
| \`explain\` | Summarize project resources |
| \`scaffold\` | Generate starter files |
| \`search\` | Search available resource types |
| \`gitlab:diff\` | Compare current build output against previous |

| MCP resource | Description |
|--------------|-------------|
| \`resource-catalog\` | JSON list of all supported GitLab CI entity types |
| \`examples/basic-pipeline\` | Example pipeline with build, test, and deploy jobs |`,
      },
    ],
    basePath: "/chant/lexicons/gitlab/",
  };

  const result = await docsPipeline(config);
  writeDocsSite(config, result);

  if (opts?.verbose) {
    console.error(
      `Generated docs: ${result.stats.resources} resources, ${result.stats.properties} properties, ${result.stats.services} services, ${result.stats.rules} rules`,
    );
  }
}
