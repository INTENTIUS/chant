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

\`\`\`typescript
import { Job, Image, Cache, Artifacts, CI } from "@intentius/chant-lexicon-gitlab";

export const test = new Job({
  stage: "test",
  image: new Image({ name: "node:20" }),
  cache: new Cache({ key: CI.CommitRef, paths: ["node_modules/"] }),
  script: ["npm ci", "npm test"],
  artifacts: new Artifacts({
    paths: ["coverage/"],
    expireIn: "1 week",
  }),
});
\`\`\`

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
| \`expireIn: "1 week"\` | \`expire_in: 1 week\` | camelCase → snake_case |
| \`ifCondition: ...\` | \`if: ...\` | Reserved word properties use suffixed names |
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
    extraPages: [
      {
        slug: "pipeline-concepts",
        title: "Pipeline Concepts",
        description: "Jobs, stages, artifacts, caching, images, rules, environments, and triggers in the GitLab CI/CD lexicon",
        content: `Every exported \`Job\` declaration becomes a job entry in the generated \`.gitlab-ci.yml\`. The serializer handles the translation automatically:

- Converts camelCase property names to snake_case (\`expireIn\` → \`expire_in\`)
- Converts export names to kebab-case job keys (\`buildApp\` → \`build-app\`)
- Collects stages from all jobs into a \`stages:\` list
- Collapses single-property objects (\`new Image({ name: "node:20" })\` → \`image: node:20\`)

\`\`\`typescript
// This chant declaration...
export const buildApp = new Job({
  stage: "build",
  image: new Image({ name: "node:20" }),
  script: ["npm ci", "npm run build"],
});
\`\`\`

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

## The barrel file

Every chant project has a barrel file (conventionally \`_.ts\`) that re-exports the lexicon:

\`\`\`typescript
// _.ts — the barrel file
export * from "@intentius/chant-lexicon-gitlab";
export * from "./config";
\`\`\`

Other files import the barrel and use its exports:

\`\`\`typescript
// pipeline.ts
import * as _ from "./_";

export const build = new _.Job({
  stage: "build",
  image: _.nodeImage,        // from config.ts via barrel
  cache: _.npmCache,         // from config.ts via barrel
  script: ["npm ci", "npm run build"],
  artifacts: _.buildArtifacts,
});
\`\`\`

## Jobs

A \`Job\` is the fundamental unit. Every exported \`Job\` becomes a job entry in the YAML:

\`\`\`typescript
export const test = new Job({
  stage: "test",
  image: new Image({ name: "node:20-alpine" }),
  script: ["npm ci", "npm test"],
  artifacts: new Artifacts({
    paths: ["coverage/"],
    expireIn: "1 week",
    reports: { junit: "coverage/junit.xml" },
  }),
});
\`\`\`

Key properties:
- \`script\` — **required** (or \`trigger\`/\`run\`). Array of shell commands to execute.
- \`stage\` — which pipeline stage this job belongs to. Defaults to \`test\` if omitted.
- \`image\` — Docker image. Use \`new Image({ name: "..." })\` or pass a string to the YAML.
- \`needs\` — job dependencies for DAG-mode execution (run before stage ordering).

## Stages

Stages define the execution order of a pipeline. The serializer automatically collects unique stage values from all jobs:

\`\`\`typescript
export const lint = new Job({ stage: "test", script: ["npm run lint"] });
export const test = new Job({ stage: "test", script: ["npm test"] });
export const build = new Job({ stage: "build", script: ["npm run build"] });
export const deploy = new Job({ stage: "deploy", script: ["npm run deploy"] });
\`\`\`

Produces:

\`\`\`yaml
stages:
  - test
  - build
  - deploy
\`\`\`

Jobs in the same stage run in parallel. Stages run sequentially in declaration order.

## Artifacts and caching

**Artifacts** are files produced by a job and passed to later stages or stored for download:

\`\`\`typescript
export const buildArtifacts = new Artifacts({
  paths: ["dist/"],
  expireIn: "1 hour",         // always set expiry (WGL004 warns if missing)
});

export const testArtifacts = new Artifacts({
  paths: ["coverage/"],
  expireIn: "1 week",
  reports: { junit: "coverage/junit.xml" },  // parsed by GitLab for MR display
});
\`\`\`

**Caches** persist files between pipeline runs to speed up builds:

\`\`\`typescript
export const npmCache = new Cache({
  key: "$CI_COMMIT_REF_SLUG",   // cache per branch
  paths: ["node_modules/"],
  policy: "pull-push",          // "pull" for read-only, "push" for write-only
});
\`\`\`

The key difference: artifacts are for passing files between **stages in the same pipeline**; caches are for speeding up **repeated pipeline runs**.

## Conditional execution with rules

\`Rule\` objects control when a job runs. They map to \`rules:\` entries in the YAML:

\`\`\`typescript
export const onMergeRequest = new Rule({
  ifCondition: CI.MergeRequestIid,    // → if: $CI_MERGE_REQUEST_IID
});

export const onDefaultBranch = new Rule({
  ifCondition: \`\${CI.CommitBranch} == \${CI.DefaultBranch}\`,
  when: "manual",                      // require manual trigger
});

export const deploy = new Job({
  stage: "deploy",
  script: ["npm run deploy"],
  rules: [onDefaultBranch],
});
\`\`\`

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

\`\`\`typescript
export const productionEnv = new Environment({
  name: "production",
  url: "https://example.com",
});

export const deploy = new Job({
  stage: "deploy",
  script: ["npm run deploy"],
  environment: productionEnv,
  rules: [onDefaultBranch],
});
\`\`\`

GitLab tracks deployments to environments and provides rollback capabilities in the UI.

## Images and services

\`Image\` specifies the Docker image for a job:

\`\`\`typescript
export const nodeImage = new Image({ name: "node:20-alpine" });

// With entrypoint override
export const customImage = new Image({
  name: "registry.example.com/my-image:latest",
  entrypoint: ["/bin/sh", "-c"],
});
\`\`\`

## Workflow

\`Workflow\` controls pipeline-level settings — when pipelines run, auto-cancellation, and global includes:

\`\`\`typescript
export const workflow = new Workflow({
  name: "CI Pipeline for $CI_COMMIT_REF_NAME",
  rules: [
    new Rule({ ifCondition: CI.MergeRequestIid }),
    new Rule({ ifCondition: CI.CommitBranch }),
  ],
  autoCancel: new AutoCancel({
    onNewCommit: "interruptible",
  }),
});
\`\`\`

## Default

\`Default\` sets shared configuration inherited by all jobs:

\`\`\`typescript
export const defaults = new Default({
  image: new Image({ name: "node:20-alpine" }),
  cache: new Cache({ key: CI.CommitRef, paths: ["node_modules/"] }),
  retry: new Retry({ max: 2, when: ["runner_system_failure"] }),
});
\`\`\`

Jobs can override any default property individually.

## Triggers

\`Trigger\` creates downstream pipeline jobs:

\`\`\`typescript
export const deployInfra = new Job({
  stage: "deploy",
  trigger: new Trigger({
    project: "my-group/infra-repo",
    branch: "main",
    strategy: "depend",
  }),
});
\`\`\``,
      },
      {
        slug: "variables",
        title: "Predefined Variables",
        description: "GitLab CI/CD predefined variable references",
        content: `The \`CI\` object provides type-safe access to GitLab CI/CD predefined variables. These map to \`$CI_*\` environment variables at runtime.

\`\`\`typescript
import { CI, Job, Rule } from "@intentius/chant-lexicon-gitlab";

// Use in rule conditions
const onDefault = new Rule({
  ifCondition: \`\${CI.CommitBranch} == \${CI.DefaultBranch}\`,
});

// Use in cache keys
const cache = new Cache({
  key: CI.CommitRef,       // → $CI_COMMIT_REF_NAME
  paths: ["node_modules/"],
});

// Use in workflow names
const workflow = new Workflow({
  name: \`Pipeline for \${CI.CommitRef}\`,
});
\`\`\`

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

**Conditional on branch type:**

\`\`\`typescript
// Only on merge requests
new Rule({ ifCondition: CI.MergeRequestIid })

// Only on default branch
new Rule({ ifCondition: \`\${CI.CommitBranch} == \${CI.DefaultBranch}\` })

// Only on tags
new Rule({ ifCondition: CI.CommitTag })
\`\`\`

**Dynamic naming:**

\`\`\`typescript
export const deploy = new Job({
  stage: "deploy",
  environment: new Environment({
    name: \`review/\${CI.CommitRef}\`,
    url: \`https://\${CI.CommitRef}.preview.example.com\`,
  }),
  script: ["deploy-preview"],
});
\`\`\`

**Container registry:**

\`\`\`typescript
export const buildImage = new Job({
  stage: "build",
  image: new Image({ name: "docker:24" }),
  script: [
    \`docker build -t \${CI.RegistryImage}:\${CI.CommitSha} .\`,
    \`docker push \${CI.RegistryImage}:\${CI.CommitSha}\`,
  ],
});
\`\`\`
`,
      },
      {
        slug: "intrinsics",
        title: "Intrinsic Functions",
        description: "GitLab CI/CD intrinsic functions and their chant syntax",
        content: `The GitLab lexicon provides one intrinsic function: \`reference()\`, which maps to GitLab's \`!reference\` YAML tag.

\`\`\`typescript
import { reference } from "@intentius/chant-lexicon-gitlab";
\`\`\`

## \`reference()\` — reuse job properties

The \`reference()\` intrinsic lets you reuse properties from other jobs or hidden keys. It produces the \`!reference\` YAML tag:

\`\`\`typescript
import { reference, Job } from "@intentius/chant-lexicon-gitlab";

export const deploy = new Job({
  script: reference(".setup", "script"),
});
\`\`\`

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

**Shared setup scripts:**

\`\`\`typescript
// Hidden key with shared setup (defined in .gitlab-ci.yml or included)
// Reference its script from multiple jobs:

export const test = new Job({
  stage: "test",
  beforeScript: reference(".node-setup", "before_script"),
  script: ["npm test"],
});

export const lint = new Job({
  stage: "test",
  beforeScript: reference(".node-setup", "before_script"),
  script: ["npm run lint"],
});
\`\`\`

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

**Shared rules:**

\`\`\`typescript
export const build = new Job({
  stage: "build",
  rules: reference(".default-rules", "rules"),
  script: ["npm run build"],
});
\`\`\`

**Nested references (multi-level):**

\`\`\`typescript
// Reference a specific nested element
export const deploy = new Job({
  script: reference(".setup", "script"),
  environment: reference(".deploy-defaults", "environment"),
});
\`\`\`

### When to use \`reference()\` vs barrel imports

Use **barrel imports** (\`_.$\`) when referencing chant-managed objects — the serializer resolves them at build time:

\`\`\`typescript
// Preferred for chant-managed config
export const test = new Job({
  cache: _.npmCache,           // resolved at build time
  artifacts: _.testArtifacts,  // resolved at build time
});
\`\`\`

Use **\`reference()\`** when referencing jobs or hidden keys defined outside chant (e.g. in included YAML files or templates):

\`\`\`typescript
// For external/included YAML definitions
export const test = new Job({
  beforeScript: reference(".ci-setup", "before_script"),
});
\`\`\`
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

\`\`\`typescript
// Triggers WGL001
export const deploy = new Job({
  stage: "deploy",
  script: ["npm run deploy"],
  only: ["main"],                // deprecated
});

// Fixed — use rules instead
export const deploy = new Job({
  stage: "deploy",
  script: ["npm run deploy"],
  rules: [new Rule({
    ifCondition: \`\${CI.CommitBranch} == \${CI.DefaultBranch}\`,
  })],
});
\`\`\`

### WGL002 — Missing script

**Severity:** error | **Category:** correctness

A GitLab CI job must have \`script\`, \`trigger\`, or \`run\` defined. Jobs without any of these will fail pipeline validation.

\`\`\`typescript
// Triggers WGL002
export const build = new Job({
  stage: "build",
  image: new Image({ name: "node:20" }),
  // Missing script!
});

// Fixed — add script
export const build = new Job({
  stage: "build",
  image: new Image({ name: "node:20" }),
  script: ["npm run build"],
});

// Also valid — trigger job (no script needed)
export const downstream = new Job({
  trigger: new Trigger({ project: "my-group/other-repo" }),
});
\`\`\`

### WGL003 — Missing stage

**Severity:** info | **Category:** style

Jobs should declare a \`stage\` property. Without it, the job defaults to the \`test\` stage, which may not be the intended behavior.

\`\`\`typescript
// Triggers WGL003
export const build = new Job({
  script: ["npm run build"],
  // No stage — defaults to "test"
});

// Fixed — declare the stage
export const build = new Job({
  stage: "build",
  script: ["npm run build"],
});
\`\`\`

### WGL004 — Artifacts without expiry

**Severity:** warning | **Category:** performance

Flags \`Artifacts\` without \`expireIn\`. Artifacts without expiry are kept indefinitely, consuming storage. Always set an expiration.

\`\`\`typescript
// Triggers WGL004
export const build = new Job({
  script: ["npm run build"],
  artifacts: new Artifacts({
    paths: ["dist/"],
    // Missing expireIn!
  }),
});

// Fixed — set expiry
export const build = new Job({
  script: ["npm run build"],
  artifacts: new Artifacts({
    paths: ["dist/"],
    expireIn: "1 hour",
  }),
});
\`\`\`

## Post-synth checks

Post-synth checks run against the serialized YAML after build. They catch issues only visible in the final output.

### WGL010 — Undefined stage

**Severity:** error

Flags jobs that reference a stage not present in the collected stages list. This causes a pipeline validation error in GitLab.

### WGL011 — Unreachable job

**Severity:** warning

Flags jobs where all \`rules:\` entries have \`when: "never"\`, making the job unreachable. This usually indicates a configuration error.

\`\`\`typescript
// Triggers WGL011 — job can never run
export const noop = new Job({
  script: ["echo unreachable"],
  rules: [
    new Rule({ ifCondition: CI.CommitBranch, when: "never" }),
    new Rule({ ifCondition: CI.CommitTag, when: "never" }),
  ],
});
\`\`\`

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
      WGL003: "off",  // don't require stage on every job
    },
  },
};
\`\`\`
`,
      },
      {
        slug: "examples",
        title: "Examples",
        description: "Walkthrough of the getting-started GitLab CI/CD example",
        content: `A runnable example lives in the lexicon's \`examples/\` directory. Clone the repo and try it:

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
├── _.ts           # Barrel — re-exports lexicon + shared config
├── config.ts      # Shared config: images, caches, artifacts, rules, environments
└── pipeline.ts    # Job definitions: build, test, deploy
\`\`\`

### Barrel file

The barrel re-exports both the lexicon and shared config, so pipeline files only need one import:

\`\`\`typescript
// _.ts
export * from "@intentius/chant-lexicon-gitlab";
export * from "./config";
\`\`\`

### Shared configuration

\`config.ts\` extracts reusable objects — images, caches, artifacts, rules, and environments — so jobs stay concise:

\`\`\`typescript
// config.ts
import * as _ from "./_";

export const nodeImage = new _.Image({ name: "node:20-alpine" });

export const npmCache = new _.Cache({
  key: "$CI_COMMIT_REF_SLUG",
  paths: ["node_modules/"],
  policy: "pull-push",
});

export const buildArtifacts = new _.Artifacts({
  paths: ["dist/"],
  expireIn: "1 hour",
});

export const testArtifacts = new _.Artifacts({
  paths: ["coverage/"],
  expireIn: "1 week",
  reports: { junit: "coverage/junit.xml" },
});

export const onMergeRequest = new _.Rule({
  ifCondition: _.CI.MergeRequestIid,
});

export const onCommit = new _.Rule({
  ifCondition: _.CI.CommitBranch,
});

export const onDefaultBranch = new _.Rule({
  ifCondition: \`\${_.CI.CommitBranch} == \${_.CI.DefaultBranch}\`,
  when: "manual",
});

export const productionEnv = new _.Environment({
  name: "production",
  url: "https://example.com",
});
\`\`\`

### Pipeline jobs

\`pipeline.ts\` defines three jobs that reference shared config via the barrel:

\`\`\`typescript
// pipeline.ts
import * as _ from "./_";

export const build = new _.Job({
  stage: "build",
  image: _.nodeImage,
  cache: _.npmCache,
  script: ["npm ci", "npm run build"],
  artifacts: _.buildArtifacts,
});

export const test = new _.Job({
  stage: "test",
  image: _.nodeImage,
  cache: _.npmCache,
  script: ["npm ci", "npm test"],
  artifacts: _.testArtifacts,
  rules: [_.onMergeRequest, _.onCommit],
});

export const deploy = new _.Job({
  stage: "deploy",
  image: _.nodeImage,
  script: ["npm run deploy"],
  environment: _.productionEnv,
  rules: [_.onDefaultBranch],
});
\`\`\`

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

1. **Barrel file** — single import point for lexicon types and shared config
2. **Shared config** — reusable images, caches, artifacts, and rules extracted into \`config.ts\`
3. **Conditional execution** — merge request and branch rules control when jobs run
4. **Manual deployment** — deploy requires manual trigger on the default branch
5. **JUnit reports** — test artifacts include JUnit XML for GitLab MR display
`,
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
