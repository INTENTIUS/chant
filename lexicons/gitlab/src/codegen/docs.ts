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

The lexicon provides **3 resources** (Job, Workflow, Default), **16 property types** (Image, Cache, Artifacts, Rule, Environment, Trigger, Need, Service, and more), the \`CI\` pseudo-parameter object for predefined variables, and the \`reference()\` intrinsic for YAML \`!reference\` tags. It also ships **4 lint rules** + **39 post-synth checks** (including a CI/CD supply-chain security pass, WGL029–048) and a [\`chant migrate\`](./migration) source for translating GitHub Actions workflows.
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
        content: `import Diagram from '../../components/Diagram.astro';

Every exported \`Job\` declaration becomes a job entry in the generated \`.gitlab-ci.yml\`. The serializer handles the translation automatically:

<Diagram name="pipeline-hierarchy" alt="GitLab Pipeline with stages (build, test, deploy) each containing jobs, with stage dependencies flowing left to right" caption="GitLab CI pipeline hierarchy" />

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

The lexicon provides 3 resource types and 16 property types:

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
| \`Need\` | Job | Job dependency for DAG-mode execution |
| \`Inherit\` | Job | Controls which global defaults a job inherits |
| \`Service\` | Job, Default | Sidecar service container (e.g. Docker-in-Docker, databases) |
| \`WorkflowRule\` | Workflow | Conditional rules for pipeline-level execution |

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

The \`if\` property maps directly to \`if:\` in the YAML. Use the \`CI\` pseudo-parameter object for type-safe variable references.

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

### WGL016 — Secret in a variables block

**Severity:** error

Detects hardcoded passwords, tokens, or keys in a \`variables:\` block. Move them to CI/CD masked variables instead of committing them to the pipeline. The precursor to the WGL038–040 secret-scoping checks.

### WGL017 — Insecure registry

**Severity:** warning

Flags Docker push/pull to a non-HTTPS registry in a job script. HTTP gives the registry traffic no transport integrity.

### WGL018 — Missing timeout

**Severity:** warning

Flags jobs without an explicit \`timeout:\`. The instance default (often 1 hour) is too long for most jobs and lets a hung job hold a runner.

### WGL019 — Missing retry on deploy jobs

**Severity:** info

Deploy-stage jobs benefit from a \`retry:\` strategy to ride out transient infrastructure failures. Informational, not required.

### WGL020 — Duplicate job names

**Severity:** error

Detects multiple jobs that resolve to the same kebab-case key in the serialized YAML. GitLab silently merges duplicate keys, so one job's config quietly overwrites the other.

### WGL021 — Unused variables

**Severity:** warning

Flags global \`variables:\` not referenced by any job script — usually stale configuration adding noise.

### WGL022 — Missing artifacts expiry

**Severity:** warning

Flags \`artifacts:\` without \`expire_in:\`. Depending on instance config the default is "never expire," which bloats storage.

### WGL023 — Overly broad rules

**Severity:** info

Flags a job whose only rule is \`when: always\` with no conditions (\`if:\`, \`changes:\`, …). That disables all pipeline filtering for the job, which is usually unintended.

### WGL024 — Manual without allow_failure

**Severity:** warning

Flags \`when: manual\` jobs that don't set \`allow_failure: true\`. Without it the manual job blocks the pipeline from progressing past its stage until someone triggers it.

### WGL025 — Missing cache key

**Severity:** warning

Flags \`cache:\` without a \`key:\`. GitLab falls back to the \`default\` key, causing cache collisions between unrelated jobs on the same runner.

### WGL026 — Privileged services without TLS

**Severity:** warning

Flags Docker-in-Docker (DinD) services that don't set \`DOCKER_TLS_CERTDIR\`, leaving the Docker daemon on an unencrypted socket. Extended by WGL036 for the merge-request-reachable case.

### WGL027 — Empty script

**Severity:** error

Detects jobs with \`script: []\` or only empty strings. GitLab rejects empty scripts at pipeline validation time.

### WGL028 — Redundant needs

**Severity:** info

Detects \`needs:\` entries already implied by stage ordering. Not incorrect, but redundant needs add noise and make the pipeline harder to maintain.

## Supply-chain security pass (WGL029–048)

WGL029 onward are a CI/CD supply-chain security pass, the GitLab counterpart to the github lexicon's GHA029–058: pin & vet includes/components/images, scope \`CI_JOB_TOKEN\` and OIDC, guard trust boundaries against untrusted CI input, mask/protect/scope secrets, reject unsound \`rules:\` expressions, and keep artifacts/caches honest. They run statically on the emitted \`.gitlab-ci.yml\`.

The checks that need a *moving external truth* — whether a pinned component/include ref still resolves, whether an upstream was archived or moved, whether a new advisory covers a component in use — live in the operational layer instead. Schedule the [\`PipelineAuditOp\`](/chant/guide/ops/#audit-supply-chain-drift) (temporal lexicon) for that live half; it reads the emitted \`include:\` / \`component:\` / \`image:\` references and reports drift via \`report | issue | merge-request\`.

### WGL029 — Unpinned include:project / component

**Severity:** warning

Flags an \`include:project\` or CI/CD \`component:\` resolved by a moving ref — a branch, a missing \`ref:\` (defaults to the default branch), or a floating component version — instead of a pinned tag or commit SHA.

### WGL030 — Mutable or insecure include:remote

**Severity:** error (HTTP) / warning (HTTPS)

Flags \`include:remote\` URLs fetched over HTTP (no transport integrity) or over HTTPS but inherently mutable. Prefer a pinned \`include:project\` or component. Generalizes WGL017 to includes.

### WGL031 — Container image without a digest

**Severity:** warning

Flags \`image:\` and \`services:\` references not pinned to an immutable \`@sha256:\` digest. Variable-based references (e.g. \`$CI_REGISTRY_IMAGE:tag\`) are skipped.

### WGL032 — Look-alike include/component source

**Severity:** warning

Flags an \`include:project\` / \`component:\` source that is a near-miss (edit distance 1–2) of a well-known GitLab CI source but not an exact match — a likely typo or impersonation. Backed by a vendored reference list.

### WGL033 — OIDC id_token without a scoped audience

**Severity:** warning

Flags an \`id_tokens:\` declaration with no \`aud:\` or a wildcard audience. The audience binds the minted OIDC token to a relying party; without it a leaked token is accepted anywhere.

### WGL034 — OIDC id_token mintable from a merge-request pipeline

**Severity:** warning

Flags a job that declares \`id_tokens:\` and is reachable from merge-request pipelines, which outside contributors can trigger. Restrict OIDC jobs to protected refs or require approval.

> The project-level \`CI_JOB_TOKEN\` allowlist and a variable's protected status are project settings, not emitted pipeline YAML, so they are out of scope for these post-synth checks (see issue #298's caveat).

### WGL035 — Untrusted CI variable in a script

**Severity:** warning

Flags an attacker-controllable predefined variable (branch/tag name, commit or MR title/description, author) referenced in a \`script:\` command, where a crafted value can inject shell commands. Quote it and avoid using it in sensitive commands.

### WGL036 — Privileged DinD reachable from merge requests

**Severity:** warning

Flags a Docker-in-Docker (privileged) job reachable from merge-request pipelines, which outside contributors can trigger. Restrict privileged services to protected refs. Complements WGL026.

### WGL037 — Regex gate on an untrusted ref

**Severity:** warning

Flags a \`rules:if\` that gates on a regex match (\`=~\`) over an attacker-controllable ref variable — a crafted branch/tag name can satisfy the pattern. Match the full ref with \`==\` or gate on a protected condition.

### WGL038 — Secret reachable from a merge-request pipeline

**Severity:** warning

Flags a user-defined secret-like variable read by a job reachable from merge-request pipelines, which can run untrusted code. Gate the job to protected refs or mark the variable protected. (Built-in \`CI_*\` variables are excluded.)

### WGL039 — Secret echoed to job logs

**Severity:** warning

Flags a \`script:\` command that prints a secret-like variable (\`echo\`/\`printf\`/\`cat\`). Logs are broadly readable and masking can be defeated by transforms.

### WGL040 — Hardcoded registry credential

**Severity:** error

Flags a \`docker login\` (or compatible) passing a literal password via \`-p\`/\`--password\` instead of a variable or \`--password-stdin\`. Extends WGL016 to scripts.

> Variable *masking* and *protected* status are GitLab project/CI-settings, not emitted YAML — WGL016 already nudges toward masked variables; this group covers the exposure paths visible in the pipeline.

### WGL041 — Unsound rules:if condition

**Severity:** warning

Flags a tautological \`rules:if\` where both sides of \`==\`/\`!=\` are identical, so the condition is always true or always false. Generalizes WGL011 to conditions presented as gates.

### WGL042 — Unreachable rules after an unconditional match

**Severity:** warning

Flags rules listed after an unconditional rule (no \`if:\`, not \`when: never\`). GitLab takes the first matching rule, so a catch-all makes everything after it dead. Put specific rules first.

### WGL043 — Match-anything regex gate

**Severity:** warning

Flags a \`rules:if\` whose \`=~\` regex matches every value (empty, dot-star, anchored dot-star) — a filter that admits everything. Tighten the pattern or remove the gate.

> The auto-fix acceptance item is N/A at the post-synth layer (PostSynthDiagnostic has no fix channel); it belongs to the declarative source-lint rules.

### WGL044 — Public artifacts

**Severity:** warning

Flags \`artifacts:public: true\`, which makes build output downloadable by anyone. Keep artifacts private unless they are meant to be world-readable.

### WGL045 — Credential-bearing artifact path

**Severity:** error

Flags an \`artifacts:paths:\` entry that looks like a credential or sensitive file (\`.env\`, \`*.pem\`, \`id_rsa\`, \`*.key\`, \`.npmrc\`, \`.netrc\`, \`credentials\`). Artifacts flow downstream and are downloadable — exclude the file.

### WGL046 — Cache poisoning from a merge-request pipeline

**Severity:** warning

Flags a job that writes a cache (push policy) and is reachable from merge-request pipelines. An MR can poison the cache for a later protected run that restores the same key. Restrict cache writes to protected refs or scope the key.

> Artifact / \`dependencies:\` flow across a *protected* boundary depends on a ref's protected status, a project setting not present in emitted YAML — out of scope here.

### WGL047 — Software fetched and piped to a shell

**Severity:** warning

Flags a \`script:\` command that pipes a network download straight into a shell (\`curl ... | bash\`). The fetched code is unpinned and unverified — download to a file, verify a checksum/signature, then run it.

### WGL048 — Pipeline without a name

**Severity:** info

Flags a pipeline that defines a \`workflow:\` block but no \`workflow:name\`. A pipeline name aids identification in the GitLab UI and audit output.

> Two #304 items stay out of scope: a broad privileged-service / DinD check (already covered by WGL026 for DinD-TLS and WGL036 for MR-reachable DinD; a runner's privileged isolation is not in emitted YAML) and an optional include/component allowlist policy (configuration, overlapping WGL032's vendored source list).

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
npm install
chant build    # produces .gitlab-ci.yml
chant lint     # runs lint rules
npx vitest run    # run the tests
\`\`\`

## Getting Started

\`examples/getting-started/\` — a 2-stage Node.js pipeline with build and test jobs.

\`\`\`
src/
├── config.ts      # Shared config: image, cache
└── pipeline.ts    # Job definitions: build, test
\`\`\`

### Shared configuration

\`config.ts\` extracts reusable objects — image and cache — so jobs stay concise:

{{file:getting-started/src/config.ts}}

### Pipeline jobs

\`pipeline.ts\` defines two jobs that import shared config:

{{file:getting-started/src/pipeline.ts}}

### Generated output

\`chant build\` produces this \`.gitlab-ci.yml\`:

\`\`\`yaml
stages:
  - build
  - test

build:
  stage: build
  image:
    name: node:20-alpine
  cache:
    key: '$CI_COMMIT_REF_SLUG'
    paths:
      - node_modules/
    policy: pull-push
  script:
    - npm install
    - npm run build

test:
  stage: test
  image:
    name: node:20-alpine
  cache:
    key: '$CI_COMMIT_REF_SLUG'
    paths:
      - node_modules/
    policy: pull-push
  script:
    - npm install
    - npm test
  artifacts:
    reports:
      junit: coverage/junit.xml
    paths:
      - coverage/
    expire_in: '1 week'
\`\`\`

**Patterns demonstrated:**

1. **Shared config** — reusable image and cache extracted into \`config.ts\`
2. **JUnit reports** — test artifacts include JUnit XML for GitLab MR display
3. **Stage ordering** — stages collected automatically from job declarations

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

## Merge-request plan widget

The \`MrPlanReport\` composite turns \`chant lifecycle plan\` into the GitLab merge-request plan widget — the "N to add, M to change, K to delete" summary GitLab renders from an \`artifacts:reports:terraform\` artifact:

\`\`\`typescript
import { MrPlanReport } from "@intentius/chant-lexicon-gitlab";

export const plan = MrPlanReport({
  environment: "prod",
  // credential setup — the plan queries the live system to classify drift
  before: ["aws sts get-caller-identity"],
});
\`\`\`

The job runs \`chant lifecycle plan prod --report gitlab-mr\`, writes the count JSON to \`tfplan.json\`, and declares it as \`artifacts:reports:terraform\`. On the merge request, GitLab shows the plan summary inline.

Caveats worth knowing:

- The widget label always reads **"Terraform"** — that is GitLab's fixed string for this report type, not a claim chant makes.
- It is **counts only** (create/update/delete). \`adopt\` and \`noop\` are excluded, since the widget has no column for live-but-undeclared or no-change. There is no per-resource breakdown — run \`chant lifecycle plan\` in the job log for that.
- It is a **GitLab-only** surface. The same plan JSON is portable, but the widget is GitLab's.
- The plan reads the live system, so the job needs cloud credentials — wire them via \`before\` or CI variables.

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

Builds a Docker image, pushes to ECR, and deploys the API service stack with cross-stack parameter passing. The full source lives in the cross-lexicon example \`examples/gitlab-aws-alb-api/\`:

{{file:../../../examples/gitlab-aws-alb-api/src/pipeline.ts}}

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

When you scaffold a new project with \`chant init --lexicon gitlab\`, the skill is installed to \`skills/chant-gitlab/SKILL.md\` for automatic discovery by Claude Code.

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
- **Troubleshooting** — job logs, lint rule codes (WGL001–WGL004), post-synth checks (WGL010–WGL048)

The skill is invocable as a slash command: \`/chant-gitlab\`

## Skill: chant-gitlab-migrate

Operational glue for translating GitHub Actions workflows to GitLab CI/CD. The skill detects the user's intent (paste a \`.github/workflows/*.yml\`, ask about migrating, etc.), invokes \`chant migrate\`, surfaces the report, and suggests GitLab-native upgrade moments like \`--use-composites\`.

See [Migration](../migration) for the full CLI surface, supported translations, and limitations.

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
| \`gitlab:migrate\` | Translate a GitHub Actions workflow into GitLab CI/CD (see [Migration](../migration)) |
| \`gitlab:checks\` | Build and return the pipeline's security/correctness findings (the WGL checks) |
| \`gitlab:pipeline\` | Build and return the pipeline's stages and jobs (name, stage, run order), as written |
| \`gitlab:references\` | Build and list what the pipeline pulls in (includes, components, images) and whether each is pinned |
| \`gitlab:affected\` | Given a job, list the jobs that would re-run because they depend on it |
| \`gitlab:pipeline-yaml\` | Build and return the generated \`.gitlab-ci.yml\` |
| \`gitlab:source\` | Given a job, where it came from in the TypeScript — the declaring file and the composite that expanded it, if any (entity-level, not a YAML-line source map) |
| \`gitlab:owns\` | Given a job, whether it is declared (owned) by chant in this project. Pipeline jobs are not taggable cloud resources, so ownership here means "declared here" — live ownership markers apply to cloud lexicons |
| \`gitlab:compare\` | Given a GitHub Actions workflow file, migrate it to GitLab CI and report which security properties survive (translated/approximated/needs-review/lost) — the migration safety view |

The \`gitlab:checks\` / \`gitlab:pipeline\` / \`gitlab:references\` / \`gitlab:affected\` / \`gitlab:pipeline-yaml\` / \`gitlab:source\` / \`gitlab:owns\` / \`gitlab:compare\` tools are **read-only**: they build (or migrate) from source and never touch the live GitLab instance. They give an agent a *before-it-runs* view of the pipeline — what it does, what it pulls in, whether it is safe, where it came from, and what survives a migration — to complement the *after-it-ran* view it gets from the instance.

> **Why no \`github:compare\`?** The GitHub → GitLab migration lives in the GitLab lexicon (the GitHub lexicon does not depend on GitLab). A \`github:compare\` would invert that dependency, so the migration safety view is exposed once, here, as \`gitlab:compare\`.

| MCP resource | Description |
|--------------|-------------|
| \`resource-catalog\` | JSON list of all supported GitLab CI entity types |
| \`examples/basic-pipeline\` | Example pipeline with build, test, and deploy jobs |`,
      },
    ],
    extraSections: [
      {
        title: "Migrating from GitHub Actions",
        content: `\`chant migrate\` translates GitHub Actions workflows into GitLab CI/CD pipelines or typed chant source. See [Migration](./migration) for the full CLI surface, supported translations, and limitations.`,
      },
    ],
    sidebarExtra: [{ label: "Migration", slug: "migration" }],
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
