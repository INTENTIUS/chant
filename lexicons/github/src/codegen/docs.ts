/**
 * Documentation generation for GitHub Actions lexicon.
 */

import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { docsPipeline, writeDocsSite, type DocsConfig } from "@intentius/chant/codegen/docs";

function serviceFromType(resourceType: string): string {
  const parts = resourceType.split("::");
  return parts.length >= 2 ? parts[1] : "Actions";
}

const overview = `The **GitHub Actions** lexicon provides typed constructors for GitHub Actions
workflow configuration. It covers workflows, jobs, steps, triggers, strategy,
permissions, concurrency, and more.

Install it with:

\`\`\`bash
npm install --save-dev @intentius/chant-lexicon-github
\`\`\`

## Quick Start

{{file:docs-snippets/src/quickstart.ts}}

The lexicon provides **3 resources** (Workflow, Job, Dependabot config), **14 composites** (Checkout, SetupNode, SetupGo, SetupPython, CacheAction, UploadArtifact, DownloadArtifact, NodeCI, NodePipeline, PythonCI, DockerBuild, DeployEnvironment, GoCI, Dependabot) + **3 presets** (BunPipeline, PnpmPipeline, YarnPipeline), a typed **Expression** system with 24 GitHub and 5 Runner context variables, and **13 lint rules** + **45 post-synth checks** (including a CI/CD supply-chain security pass, GHA029–058).
`;

const outputFormat = `The GitHub Actions lexicon serializes resources into **\`.github/workflows/*.yml\`** YAML files.
Keys use kebab-case for job properties and snake_case for trigger event names.

## Building

Run \`chant build\` to produce workflow YAML from your declarations:

\`\`\`bash
chant build src/ --output .github/workflows/ci.yml
# Or build all workflow files
chant build
\`\`\`

The generated file includes:

- \`name:\` — workflow display name
- \`on:\` — trigger events (push, pull_request, schedule, workflow_dispatch, etc.)
- \`permissions:\` — workflow-level GITHUB_TOKEN permissions
- \`jobs:\` — job definitions with kebab-case keys

## Key conversions

| Chant (TypeScript) | YAML output | Rule |
|--------------------|-------------|------|
| \`export const buildApp = new Job({...})\` | \`jobs: build-app:\` | Export name → kebab-case job key |
| \`"runs-on": "ubuntu-latest"\` | \`runs-on: ubuntu-latest\` | Property names match GitHub spec |
| \`timeoutMinutes: 15\` | \`timeout-minutes: 15\` | camelCase → kebab-case for job properties |
| \`new Step({ uses: "actions/checkout@v4" })\` | \`- uses: actions/checkout@v4\` | Steps serialize as sequence entries |

## Validating locally

The output is standard GitHub Actions YAML. Validate locally with \`act\` or push to GitHub:

\`\`\`bash
# Using act for local testing
act -W .github/workflows/ci.yml

# Using GitHub's workflow validation (requires push)
git add .github/workflows/ci.yml
git push
\`\`\`

## Compatibility

The output is compatible with:
- GitHub Actions (any GitHub.com or GitHub Enterprise Server)
- \`act\` local runner
- VS Code GitHub Actions extension
- Any tool that processes \`.github/workflows/*.yml\` files`;

/**
 * Generate documentation for the GitHub Actions lexicon.
 */
export async function generateDocs(opts?: { verbose?: boolean }): Promise<void> {
  const pkgDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

  const config: DocsConfig = {
    name: "github",
    displayName: "GitHub Actions",
    description: "Typed constructors for GitHub Actions workflow configuration",
    distDir: join(pkgDir, "dist"),
    outDir: join(pkgDir, "docs"),
    overview,
    outputFormat,
    serviceFromType,
    suppressPages: ["intrinsics", "rules"],
    examplesDir: join(pkgDir, "examples"),
    extraSections: [
      {
        title: "Migrating to GitLab CI/CD?",
        content: `The GitLab lexicon ships a typed-compiler migration tool that translates \`.github/workflows/*.yml\` into \`.gitlab-ci.yml\` (or chant TypeScript) with provenance, 33 curated marketplace-action mappings, and optional composite recognition. See [GitLab → Migration from GitHub Actions](/chant/lexicons/gitlab/migration/) or the [\`chant migrate\` CLI reference](/chant/cli/migrate/).`,
      },
    ],
    extraPages: [
      {
        slug: "getting-started",
        title: "Getting Started",
        description: "Step-by-step guide to building your first GitHub Actions workflow with chant",
        content: `## 1. Install

\`\`\`bash
mkdir my-project && cd my-project
npm init -y
npm install --save-dev @intentius/chant @intentius/chant-lexicon-github typescript
\`\`\`

## 2. Create your workflow

Create \`src/ci.ts\`:

{{file:docs-snippets/src/quickstart.ts}}

## 3. Build

\`\`\`bash
chant build src/ --output .github/workflows/ci.yml
\`\`\`

This produces \`.github/workflows/ci.yml\`:

\`\`\`yaml
name: CI
on:
  push:
    branches:
      - main
  pull_request:
    branches:
      - main
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm
      - name: Install
        run: npm ci
      - name: Build
        run: npm run build
      - name: Test
        run: npm test
\`\`\`

## 4. Lint

\`\`\`bash
chant lint src/
\`\`\`

Lint checks for common issues — missing timeouts, hardcoded secrets, raw expression strings, and more. See the [Lint Rules](/chant/lexicons/github/lint-rules/) page for the full list.

## 5. Deploy

Commit the generated YAML and push:

\`\`\`bash
git add .github/workflows/ci.yml
git commit -m "Add CI workflow"
git push
\`\`\`

GitHub automatically picks up any \`.github/workflows/*.yml\` files and runs them on the configured triggers.

## Next steps

- [Workflow Concepts](/chant/lexicons/github/workflow-concepts/) — resource types, triggers, permissions
- [Expressions](/chant/lexicons/github/expressions/) — typed expression system and condition helpers
- [Composites](/chant/lexicons/github/composites/) — pre-built action wrappers (Checkout, SetupNode, etc.)
- [Lint Rules](/chant/lexicons/github/lint-rules/) — 13 lint rules and 45 post-synth checks`,
      },
      {
        slug: "workflow-concepts",
        title: "Workflow Concepts",
        description: "Resource types, triggers, jobs, steps, permissions, and strategy in the GitHub Actions lexicon",
        content: `## Resource types

The lexicon provides 2 resource types and several property types:

### Resources

| Type | Description |
|------|-------------|
| \`Workflow\` | Top-level workflow configuration — name, triggers, permissions, concurrency |
| \`Job\` | A job within a workflow — runs-on, steps, strategy, needs, outputs |

### Property types

| Type | Used in | Description |
|------|---------|-------------|
| \`Step\` | Job | A single step — run command or action usage |
| \`Strategy\` | Job | Matrix strategy for parallel job execution |
| \`Permissions\` | Workflow, Job | GITHUB_TOKEN permission scopes |
| \`Concurrency\` | Workflow, Job | Concurrency group and cancel-in-progress settings |
| \`PushTrigger\` | Workflow (on) | Push event trigger with branch/tag/path filters |
| \`PullRequestTrigger\` | Workflow (on) | Pull request event trigger with filters |
| \`ScheduleTrigger\` | Workflow (on) | Cron-based schedule trigger |
| \`WorkflowDispatchTrigger\` | Workflow (on) | Manual dispatch with typed inputs |
| \`Environment\` | Job | Deployment environment with protection rules |
| \`Output\` | Job | Job output values for downstream jobs |

## Triggers

Triggers define when a workflow runs. Pass them in the \`on:\` field:

\`\`\`typescript
import { Workflow } from "@intentius/chant-lexicon-github";

export const workflow = new Workflow({
  name: "CI",
  on: {
    push: { branches: ["main", "release/*"] },
    pull_request: {
      branches: ["main"],
      types: ["opened", "synchronize"],
    },
    schedule: [{ cron: "0 0 * * 1" }],         // Weekly on Monday
    workflow_dispatch: {                          // Manual trigger
      inputs: {
        environment: {
          description: "Deploy target",
          required: true,
          type: "choice",
          options: ["staging", "production"],
        },
      },
    },
  },
});
\`\`\`

## Jobs and steps

Each exported \`Job\` becomes a job entry under \`jobs:\`. Steps run sequentially within a job:

\`\`\`typescript
import { Job, Step, Checkout, SetupNode } from "@intentius/chant-lexicon-github";

export const test = new Job({
  "runs-on": "ubuntu-latest",
  timeoutMinutes: 10,
  steps: [
    Checkout({}).step,
    SetupNode({ nodeVersion: "22", cache: "npm" }).step,
    new Step({ name: "Install", run: "npm ci" }),
    new Step({ name: "Test", run: "npm test" }),
  ],
});
\`\`\`

Key job properties:
- \`runs-on\` — **required**. Runner label (\`ubuntu-latest\`, \`macos-latest\`, \`windows-latest\`).
- \`steps\` — **required**. Array of \`Step\` objects.
- \`timeoutMinutes\` — maximum job duration (recommended, flagged by GHA014 if missing).
- \`needs\` — job dependencies for execution ordering.
- \`if\` — conditional execution using Expressions.
- \`strategy\` — matrix builds for parallel execution.

## Matrix strategy

Run a job across multiple configurations:

\`\`\`typescript
import { Job, Step, Checkout, SetupNode } from "@intentius/chant-lexicon-github";

export const test = new Job({
  "runs-on": "ubuntu-latest",
  strategy: {
    matrix: {
      "node-version": ["18", "20", "22"],
      os: ["ubuntu-latest", "macos-latest"],
    },
    "fail-fast": false,
  },
  steps: [
    Checkout({}).step,
    SetupNode({ nodeVersion: "\${{ matrix.node-version }}", cache: "npm" }).step,
    new Step({ name: "Test", run: "npm test" }),
  ],
});
\`\`\`

## Permissions

Control GITHUB_TOKEN permissions at the workflow or job level:

\`\`\`typescript
import { Workflow, Job, Step } from "@intentius/chant-lexicon-github";

// Workflow-level (applies to all jobs)
export const workflow = new Workflow({
  name: "Release",
  on: { push: { tags: ["v*"] } },
  permissions: {
    contents: "write",
    packages: "write",
    "id-token": "write",
  },
});

// Job-level (overrides workflow permissions for this job)
export const publish = new Job({
  "runs-on": "ubuntu-latest",
  permissions: { contents: "read", packages: "write" },
  steps: [
    new Step({ name: "Publish", run: "npm publish" }),
  ],
});
\`\`\`

Available permission scopes: \`actions\`, \`checks\`, \`contents\`, \`deployments\`, \`id-token\`, \`issues\`, \`packages\`, \`pages\`, \`pull-requests\`, \`repository-projects\`, \`security-events\`, \`statuses\`. Values: \`"read"\`, \`"write"\`, \`"none"\`.

## Concurrency

Prevent concurrent runs of the same workflow or job:

\`\`\`typescript
import { Workflow } from "@intentius/chant-lexicon-github";

export const workflow = new Workflow({
  name: "Deploy",
  on: { push: { branches: ["main"] } },
  concurrency: {
    group: "deploy-\${{ github.ref }}",
    "cancel-in-progress": true,
  },
});
\`\`\`

## Job dependencies

Use \`needs\` to order jobs and pass outputs between them:

\`\`\`typescript
import { Job, Step } from "@intentius/chant-lexicon-github";

export const build = new Job({
  "runs-on": "ubuntu-latest",
  outputs: { version: "\${{ steps.version.outputs.value }}" },
  steps: [
    new Step({
      id: "version",
      name: "Get version",
      run: 'echo "value=$(node -p \\"require(\'./package.json\').version\\")" >> $GITHUB_OUTPUT',
    }),
  ],
});

export const deploy = new Job({
  "runs-on": "ubuntu-latest",
  needs: ["build"],
  steps: [
    new Step({
      name: "Deploy",
      run: "echo Deploying version \${{ needs.build.outputs.version }}",
    }),
  ],
});
\`\`\``,
      },
      {
        slug: "expressions",
        title: "Expressions",
        description: "Typed expression system, condition helpers, and utility functions for GitHub Actions",
        content: `The Expression system provides type-safe access to GitHub Actions \`\${{ }}\` expressions. Instead of writing raw strings, use the typed helpers for better IDE support and lint coverage.

{{file:docs-snippets/src/expressions-usage.ts}}

## Expression class

The \`Expression\` class wraps a raw expression string and provides operator methods:

| Method | Example | Result |
|--------|---------|--------|
| \`.and(other)\` | \`github.ref.eq("refs/heads/main").and(isPR)\` | \`\${{ github.ref == 'refs/heads/main' && ... }}\` |
| \`.or(other)\` | \`isMain.or(isDev)\` | \`\${{ ... \\|\\| ... }}\` |
| \`.not()\` | \`isPR.not()\` | \`\${{ !(...) }}\` |
| \`.eq(value)\` | \`github.ref.eq("refs/heads/main")\` | \`\${{ github.ref == 'refs/heads/main' }}\` |
| \`.ne(value)\` | \`github.eventName.ne("schedule")\` | \`\${{ github.event_name != 'schedule' }}\` |

## Context accessors

The \`github\` and \`runner\` objects provide typed access to context properties:

\`\`\`typescript
import { github, runner } from "@intentius/chant-lexicon-github";

github.ref      // \${{ github.ref }}
github.sha      // \${{ github.sha }}
github.actor    // \${{ github.actor }}
runner.os       // \${{ runner.os }}
runner.arch     // \${{ runner.arch }}
\`\`\`

See [Variables](/chant/lexicons/github/variables/) for the full reference table.

## Dynamic context accessors

Access dynamic context values — secrets, matrix, step outputs, job outputs, inputs, vars, env:

\`\`\`typescript
import { secrets, matrix, steps, needs, inputs, vars, env } from "@intentius/chant-lexicon-github";

secrets("NPM_TOKEN")              // \${{ secrets.NPM_TOKEN }}
matrix("node-version")            // \${{ matrix.node-version }}
steps("build").outputs("path")    // \${{ steps.build.outputs.path }}
needs("build").outputs("version") // \${{ needs.build.outputs.version }}
inputs("environment")             // \${{ inputs.environment }}
vars("API_URL")                   // \${{ vars.API_URL }}
env("NODE_ENV")                   // \${{ env.NODE_ENV }}
\`\`\`

## Condition helpers

Status check functions for job and step \`if:\` fields:

| Function | Expression | Description |
|----------|-----------|-------------|
| \`always()\` | \`\${{ always() }}\` | Always run, regardless of status |
| \`failure()\` | \`\${{ failure() }}\` | Run only if a previous step failed |
| \`success()\` | \`\${{ success() }}\` | Run only if all previous steps succeeded (default) |
| \`cancelled()\` | \`\${{ cancelled() }}\` | Run only if the workflow was cancelled |

Use them in \`if:\` conditions:

\`\`\`typescript
import { Job, Step, failure, always } from "@intentius/chant-lexicon-github";

export const test = new Job({
  "runs-on": "ubuntu-latest",
  steps: [
    new Step({ name: "Test", run: "npm test" }),
    new Step({
      name: "Upload coverage",
      if: always(),
      run: "npx codecov",
    }),
    new Step({
      name: "Notify failure",
      if: failure(),
      run: "curl -X POST $SLACK_WEBHOOK",
    }),
  ],
});
\`\`\`

## Function helpers

Utility functions that produce expression strings:

| Function | Example | Expression |
|----------|---------|-----------|
| \`contains(haystack, needle)\` | \`contains(github.event, "bug")\` | \`\${{ contains(github.event, 'bug') }}\` |
| \`startsWith(value, prefix)\` | \`startsWith(github.ref, "refs/tags/")\` | \`\${{ startsWith(github.ref, 'refs/tags/') }}\` |
| \`toJSON(value)\` | \`toJSON(github.event)\` | \`\${{ toJSON(github.event) }}\` |
| \`fromJSON(json)\` | \`fromJSON(steps("meta").outputs("matrix"))\` | \`\${{ fromJSON(steps.meta.outputs.matrix) }}\` |
| \`format(template, ...args)\` | \`format("v{0}.{1}", major, minor)\` | \`\${{ format('v{0}.{1}', ...) }}\` |

## Convenience helpers

Shorthand functions for common checks:

\`\`\`typescript
import { branch, tag } from "@intentius/chant-lexicon-github";

branch("main")   // github.ref == 'refs/heads/main'
tag("v1")        // startsWith(github.ref, 'refs/tags/v1')
\`\`\`

These are useful in job \`if:\` conditions:

\`\`\`typescript
import { Job, Step, branch } from "@intentius/chant-lexicon-github";

export const deploy = new Job({
  "runs-on": "ubuntu-latest",
  if: branch("main"),
  steps: [
    new Step({ name: "Deploy", run: "npm run deploy" }),
  ],
});
\`\`\``,
      },
      {
        slug: "variables",
        title: "Variables",
        description: "GitHub and Runner context variable references for GitHub Actions workflows",
        content: `The \`GitHub\` and \`Runner\` objects provide type-safe access to GitHub Actions context variables. These expand to \`\${{ github.* }}\` and \`\${{ runner.* }}\` expressions in the generated YAML.

{{file:docs-snippets/src/variables-usage.ts}}

## GitHub context

| Property | Expression | Description |
|----------|-----------|-------------|
| \`GitHub.Ref\` | \`\${{ github.ref }}\` | Full ref (e.g. \`refs/heads/main\`, \`refs/tags/v1.0\`) |
| \`GitHub.RefName\` | \`\${{ github.ref_name }}\` | Short ref name (e.g. \`main\`, \`v1.0\`) |
| \`GitHub.RefType\` | \`\${{ github.ref_type }}\` | Ref type: \`branch\` or \`tag\` |
| \`GitHub.Sha\` | \`\${{ github.sha }}\` | Full commit SHA |
| \`GitHub.Actor\` | \`\${{ github.actor }}\` | Username that triggered the workflow |
| \`GitHub.TriggeringActor\` | \`\${{ github.triggering_actor }}\` | Username that triggered the workflow run |
| \`GitHub.Repository\` | \`\${{ github.repository }}\` | Owner/repo (e.g. \`octocat/hello-world\`) |
| \`GitHub.RepositoryOwner\` | \`\${{ github.repository_owner }}\` | Repository owner (e.g. \`octocat\`) |
| \`GitHub.EventName\` | \`\${{ github.event_name }}\` | Triggering event name (\`push\`, \`pull_request\`, etc.) |
| \`GitHub.Event\` | \`\${{ github.event }}\` | Full event payload object |
| \`GitHub.RunId\` | \`\${{ github.run_id }}\` | Unique run ID |
| \`GitHub.RunNumber\` | \`\${{ github.run_number }}\` | Run number for this workflow |
| \`GitHub.RunAttempt\` | \`\${{ github.run_attempt }}\` | Attempt number for this run |
| \`GitHub.Workflow\` | \`\${{ github.workflow }}\` | Workflow name |
| \`GitHub.WorkflowRef\` | \`\${{ github.workflow_ref }}\` | Workflow ref path |
| \`GitHub.Workspace\` | \`\${{ github.workspace }}\` | Default working directory on the runner |
| \`GitHub.Token\` | \`\${{ github.token }}\` | Automatically-generated GITHUB_TOKEN |
| \`GitHub.Job\` | \`\${{ github.job }}\` | Current job ID |
| \`GitHub.HeadRef\` | \`\${{ github.head_ref }}\` | PR head branch (pull_request events only) |
| \`GitHub.BaseRef\` | \`\${{ github.base_ref }}\` | PR base branch (pull_request events only) |
| \`GitHub.ServerUrl\` | \`\${{ github.server_url }}\` | GitHub server URL |
| \`GitHub.ApiUrl\` | \`\${{ github.api_url }}\` | GitHub API URL |
| \`GitHub.GraphqlUrl\` | \`\${{ github.graphql_url }}\` | GitHub GraphQL API URL |
| \`GitHub.Action\` | \`\${{ github.action }}\` | Action name or step ID |
| \`GitHub.ActionPath\` | \`\${{ github.action_path }}\` | Path where the action is located |

## Runner context

| Property | Expression | Description |
|----------|-----------|-------------|
| \`Runner.Os\` | \`\${{ runner.os }}\` | Runner operating system (\`Linux\`, \`Windows\`, \`macOS\`) |
| \`Runner.Arch\` | \`\${{ runner.arch }}\` | Runner architecture (\`X86\`, \`X64\`, \`ARM\`, \`ARM64\`) |
| \`Runner.Name\` | \`\${{ runner.name }}\` | Runner name |
| \`Runner.Temp\` | \`\${{ runner.temp }}\` | Path to a temporary directory on the runner |
| \`Runner.ToolCache\` | \`\${{ runner.tool_cache }}\` | Path to the tool cache directory |

## Common patterns

### Branch checks

\`\`\`typescript
import { Job, Step, GitHub } from "@intentius/chant-lexicon-github";
import { branch } from "@intentius/chant-lexicon-github";

// Deploy only on main
export const deploy = new Job({
  "runs-on": "ubuntu-latest",
  if: branch("main"),
  steps: [
    new Step({ name: "Deploy", run: "npm run deploy" }),
  ],
});
\`\`\`

### Event filtering

\`\`\`typescript
import { Job, Step, GitHub } from "@intentius/chant-lexicon-github";
import { github } from "@intentius/chant-lexicon-github";

// Skip scheduled runs
export const test = new Job({
  "runs-on": "ubuntu-latest",
  if: github.eventName.ne("schedule"),
  steps: [
    new Step({ name: "Test", run: "npm test" }),
  ],
});
\`\`\`

### Runner-specific logic

\`\`\`typescript
import { Job, Step, runner } from "@intentius/chant-lexicon-github";

export const build = new Job({
  "runs-on": "ubuntu-latest",
  steps: [
    new Step({
      name: "Platform-specific setup",
      if: runner.os.eq("Linux"),
      run: "sudo apt-get update && sudo apt-get install -y jq",
    }),
    new Step({ name: "Build", run: "npm run build" }),
  ],
});
\`\`\``,
      },
      {
        slug: "composites",
        title: "Composites",
        description: "Pre-built composites — action wrappers, CI pipelines, Docker builds, and deploy environments",
        content: `Composites are pre-built abstractions that produce typed GitHub Actions resources. They range from single-action wrappers to full multi-job workflow pipelines.

{{file:docs-snippets/src/composites-usage.ts}}

## Checkout

Wraps \`actions/checkout@v4\`. Clones the repository.

\`\`\`typescript
import { Checkout } from "@intentius/chant-lexicon-github";

Checkout({}).step                              // Default checkout
Checkout({ fetchDepth: 0 }).step               // Full history
Checkout({ ref: "develop" }).step              // Specific branch
Checkout({ submodules: "recursive" }).step     // With submodules
\`\`\`

**Props:** \`ref?\`, \`repository?\`, \`fetchDepth?\`, \`token?\`, \`submodules?\`, \`sshKey?\`

## SetupNode

Wraps \`actions/setup-node@v4\`. Installs Node.js with optional dependency caching.

\`\`\`typescript
import { SetupNode } from "@intentius/chant-lexicon-github";

SetupNode({ nodeVersion: "22" }).step              // Node 22
SetupNode({ nodeVersion: "22", cache: "npm" }).step // With npm cache
SetupNode({ nodeVersion: "20", cache: "pnpm" }).step // pnpm cache
\`\`\`

**Props:** \`nodeVersion?\`, \`cache?\` (\`"npm"\` | \`"pnpm"\` | \`"yarn"\`), \`registryUrl?\`

## SetupGo

Wraps \`actions/setup-go@v5\`. Installs Go.

\`\`\`typescript
import { SetupGo } from "@intentius/chant-lexicon-github";

SetupGo({ goVersion: "1.22" }).step
SetupGo({ goVersion: "stable" }).step
\`\`\`

**Props:** \`goVersion?\`, \`cache?\`

## SetupPython

Wraps \`actions/setup-python@v5\`. Installs Python.

\`\`\`typescript
import { SetupPython } from "@intentius/chant-lexicon-github";

SetupPython({ pythonVersion: "3.12" }).step
SetupPython({ pythonVersion: "3.12", cache: "pip" }).step
\`\`\`

**Props:** \`pythonVersion?\`, \`cache?\` (\`"pip"\` | \`"pipenv"\` | \`"poetry"\`), \`architecture?\`

## CacheAction

Wraps \`actions/cache@v4\`. Caches files between workflow runs.

\`\`\`typescript
import { CacheAction } from "@intentius/chant-lexicon-github";

CacheAction({
  path: "~/.npm",
  key: "npm-\${{ runner.os }}-\${{ hashFiles('**/package-lock.json') }}",
  restoreKeys: ["npm-\${{ runner.os }}-"],
}).step
\`\`\`

**Props:** \`path\`, \`key\`, \`restoreKeys?\`

## UploadArtifact

Wraps \`actions/upload-artifact@v4\`. Uploads files as workflow artifacts.

\`\`\`typescript
import { UploadArtifact } from "@intentius/chant-lexicon-github";

UploadArtifact({
  name: "build-output",
  path: "dist/",
  retentionDays: 7,
}).step
\`\`\`

**Props:** \`name\`, \`path\`, \`retentionDays?\`, \`ifNoFilesFound?\`

## DownloadArtifact

Wraps \`actions/download-artifact@v4\`. Downloads previously uploaded artifacts.

\`\`\`typescript
import { DownloadArtifact } from "@intentius/chant-lexicon-github";

DownloadArtifact({
  name: "build-output",
  path: "dist/",
}).step
\`\`\`

**Props:** \`name\`, \`path?\`

## NodeCI

A batteries-included composite that produces a full CI workflow and job. Generates a \`Workflow\` (push + PR on main) and a \`Job\` with checkout, setup-node, install, build, and test steps.

\`\`\`typescript
import { NodeCI } from "@intentius/chant-lexicon-github";

// Default: Node 22, npm, "build" + "test" scripts
const { workflow, job } = NodeCI({});

// Customized
const { workflow: w, job: j } = NodeCI({
  nodeVersion: "20",
  packageManager: "pnpm",
  buildScript: "compile",
  testScript: "test:ci",
});
\`\`\`

**Props:** \`nodeVersion?\`, \`packageManager?\` (\`"npm"\` | \`"pnpm"\` | \`"yarn"\` | \`"bun"\`), \`buildScript?\`, \`testScript?\`, \`installCommand?\`

The returned \`workflow\` and \`job\` can be exported directly:

\`\`\`typescript
const ci = NodeCI({ nodeVersion: "22", packageManager: "npm" });
export const workflow = ci.workflow;
export const build = ci.job;
\`\`\`

## NodePipeline

A production-grade Node pipeline with separate build and test jobs connected by artifact passing. The build job uploads artifacts; the test job downloads them and runs tests with \`needs: ["build"]\`.

\`\`\`typescript
import { NodePipeline } from "@intentius/chant-lexicon-github";

const { workflow, buildJob, testJob } = NodePipeline({
  nodeVersion: "22",
  packageManager: "pnpm",
  buildScript: "build",
  testScript: "test:ci",
  buildArtifactPaths: ["dist/", "lib/"],
});
\`\`\`

**Props:** \`nodeVersion?\`, \`packageManager?\` (\`"npm"\` | \`"pnpm"\` | \`"yarn"\` | \`"bun"\`), \`buildScript?\`, \`testScript?\`, \`installCommand?\`, \`buildArtifactPaths?\`, \`artifactName?\`, \`artifactRetentionDays?\`, \`runsOn?\`

### Presets

\`\`\`typescript
import { BunPipeline, PnpmPipeline, YarnPipeline } from "@intentius/chant-lexicon-github";

const bun = BunPipeline({});         // packageManager: "bun", uses oven-sh/setup-bun@v2
const pnpm = PnpmPipeline({});       // packageManager: "pnpm"
const yarn = YarnPipeline({});       // packageManager: "yarn"
\`\`\`

## PythonCI

Python CI with test and optional lint jobs. Supports pip and Poetry workflows.

\`\`\`typescript
import { PythonCI } from "@intentius/chant-lexicon-github";

const { workflow, testJob, lintJob } = PythonCI({
  pythonVersion: "3.12",
  testCommand: "pytest --junitxml=report.xml --cov",
  lintCommand: "ruff check .",
});

// Omit lint job
const { workflow: w, testJob: t } = PythonCI({ lintCommand: null });

// Poetry mode
const poetry = PythonCI({ usePoetry: true });
\`\`\`

**Props:** \`pythonVersion?\`, \`testCommand?\`, \`lintCommand?\` (null to omit), \`requirementsFile?\`, \`usePoetry?\`, \`runsOn?\`

## DockerBuild

Docker build and push using official Docker actions (login, setup-buildx, metadata, build-push). Configured for GitHub Container Registry by default.

\`\`\`typescript
import { DockerBuild } from "@intentius/chant-lexicon-github";

const { workflow, job } = DockerBuild({
  registry: "ghcr.io",
  imageName: "ghcr.io/my-org/my-app",
  dockerfile: "Dockerfile",
  platforms: ["linux/amd64", "linux/arm64"],
});
\`\`\`

**Props:** \`tag?\`, \`dockerfile?\`, \`context?\`, \`registry?\`, \`imageName?\`, \`tagLatest?\`, \`buildArgs?\`, \`push?\`, \`platforms?\`, \`runsOn?\`

## DeployEnvironment

Deploy and cleanup job pair using GitHub Environments with concurrency control.

\`\`\`typescript
import { DeployEnvironment } from "@intentius/chant-lexicon-github";

const { deployJob, cleanupJob } = DeployEnvironment({
  name: "staging",
  deployScript: ["npm run build", "npm run deploy"],
  cleanupScript: "npm run teardown",
  url: "https://staging.example.com",
});
\`\`\`

**Props:** \`name\` (required), \`deployScript\` (required), \`cleanupScript?\`, \`url?\`, \`concurrencyGroup?\`, \`cancelInProgress?\`, \`runsOn?\`

## GoCI

Go CI with build, test, and optional lint jobs. Uses \`golangci-lint-action\` for linting.

\`\`\`typescript
import { GoCI } from "@intentius/chant-lexicon-github";

const { workflow, buildJob, testJob, lintJob } = GoCI({
  goVersion: "1.22",
  buildCommand: "go build ./...",
  testCommand: "go test ./... -v -race",
});

// Without lint
const noLint = GoCI({ lintCommand: null });
\`\`\`

**Props:** \`goVersion?\`, \`testCommand?\`, \`buildCommand?\`, \`lintCommand?\` (null to omit), \`runsOn?\`

## Dependabot

Models the repository's dependency-update configuration (\`.github/dependabot.yml\`) as a chant resource, so it is emitted and lintable like a workflow. The composite ships **safe defaults**: a cooldown window on every ecosystem (so a version published moments ago — including a compromised one — is not adopted before anyone can react) and external code execution explicitly denied.

\`\`\`typescript
import { Dependabot } from "@intentius/chant-lexicon-github";

export const dependabot = Dependabot({
  ecosystems: [
    { packageEcosystem: "npm", directory: "/" },
    { packageEcosystem: "github-actions", directory: "/" },
  ],
  // cooldownDays defaults to 7, openPullRequestsLimit to 5
});
\`\`\`

**Props:** \`ecosystems\` (required — each \`{ packageEcosystem, directory?, interval? }\`), \`cooldownDays?\` (default 7), \`openPullRequestsLimit?\` (default 5)

For full control, construct the \`DependabotConfig\` resource directly with raw \`updates:\` entries. Two post-synth checks validate the emitted config: **GHA057** (\`insecure-external-code-execution: allow\`) and **GHA058** (no cooldown). See [Lint Rules](/chant/lexicons/github/lint-rules/).`,
      },
      {
        slug: "lint-rules",
        title: "Lint Rules",
        description: "Built-in lint rules and post-synth checks for GitHub Actions workflows",
        content: `The GitHub Actions lexicon ships lint rules that run during \`chant lint\` and post-synth checks that validate the serialized YAML after \`chant build\`.

## Lint rules

Lint rules analyze your TypeScript source code before build.

### GHA001 — Use typed action composites

**Severity:** warning | **Category:** style

Flags raw \`uses:\` strings when a typed composite wrapper is available (e.g. \`actions/checkout@v4\` → \`Checkout({})\`). Typed composites provide better IDE support and catch configuration errors at compile time.

### GHA002 — Use Expression helpers

**Severity:** warning | **Category:** style

Flags raw \`\${{ }}\` strings in \`if:\` conditions. Use the typed Expression helpers (\`github.ref.eq(...)\`, \`branch("main")\`, \`failure()\`) instead for type safety and lint coverage.

### GHA003 — No hardcoded secrets

**Severity:** error | **Category:** security

Flags hardcoded GitHub tokens, AWS keys, and other secret patterns in source code. Use \`secrets("...")\` expressions instead.

{{file:docs-snippets/src/lint-gha003.ts}}

### GHA004 — Extract inline matrix

**Severity:** info | **Category:** style

Flags inline matrix objects and suggests extracting them to named constants for readability.

### GHA005 — Extract deeply nested objects

**Severity:** info | **Category:** style

Flags deeply nested inline objects and suggests extracting them to named constants.

### GHA007 — Too many jobs per file

**Severity:** warning | **Category:** style

Flags files with more than 10 job exports. Split large workflows into separate files for maintainability.

### GHA008 — Avoid raw expression strings

**Severity:** info | **Category:** style

Flags raw \`\${{ }}\` expression strings outside of \`if:\` fields. Use the typed expression helpers (\`github.*\`, \`secrets()\`, \`matrix()\`) for better type safety.

### GHA010 — Setup action missing version

**Severity:** warning | **Category:** correctness

Flags setup action composites (SetupNode, SetupGo, SetupPython) without a version input. Pinning the version ensures reproducible builds.

### GHA012 — Deprecated action version

**Severity:** warning | **Category:** correctness

Flags action \`uses:\` references that point to deprecated versions. Upgrade to the recommended version.

### GHA014 — Missing timeout

**Severity:** warning | **Category:** correctness

Flags jobs without \`timeoutMinutes\`. Jobs without a timeout default to 360 minutes (6 hours), which can waste runner minutes if stuck.

### GHA015 — Setup without cache

**Severity:** warning | **Category:** performance

Flags setup action composites (SetupNode, SetupGo, SetupPython) without a paired \`CacheAction\` or built-in \`cache\` option. Caching dependencies significantly speeds up builds.

### GHA016 — Concurrency missing group

**Severity:** warning | **Category:** correctness

Flags \`concurrency\` with \`cancel-in-progress: true\` but no \`group\` specified. Without a group, all runs of the workflow share a single concurrency slot.

### GHA020 — Potential secret detected

**Severity:** error | **Category:** security

Flags string literals that match common secret patterns (API keys, tokens, passwords). Use \`secrets()\` or environment variables instead.

## Post-synth checks

Post-synth checks run against the serialized YAML after build. They catch issues only visible in the final output.

### GHA006 — Duplicate workflow names

**Severity:** error

Flags multiple workflows that share the same \`name:\` value. Duplicate names cause confusion in the GitHub Actions UI.

### GHA009 — Empty matrix dimension

**Severity:** error

Flags matrix strategy dimensions with an empty values array. An empty dimension causes the job to be skipped entirely.

### GHA011 — Invalid needs target

**Severity:** error

Flags jobs whose \`needs:\` entries reference a job not defined in the workflow. This causes a workflow validation error on GitHub.

### GHA013 — Missing job-level permissions for sensitive triggers

**Severity:** warning

Flags jobs without an explicit \`permissions:\` block when the workflow uses a sensitive trigger (\`pull_request_target\` or \`workflow_dispatch\`). Declaring job-level permissions keeps least-privilege scope on workflows that run with elevated context.

### GHA017 — Missing permissions block

**Severity:** info

Flags workflows without an explicit \`permissions:\` block. Omitting permissions uses the repository default (often overly broad). Following least-privilege by declaring explicit permissions is a security best practice.

### GHA018 — pull_request_target with checkout

**Severity:** warning

Flags workflows triggered by \`pull_request_target\` that include \`actions/checkout\`. This combination can be a security risk because the workflow runs with write permissions in the context of the base branch while checking out potentially untrusted PR code.

### GHA019 — Circular needs chain

**Severity:** error

Detects cycles in the \`needs:\` dependency graph. If job A needs B and B needs A (directly or transitively), GitHub rejects the workflow. Reports the full cycle chain in the diagnostic message.

### GHA021 — Checkout action not pinned to a SHA

**Severity:** warning

Flags \`actions/checkout\` referenced by a tag (e.g. \`@v4\`) instead of a pinned commit SHA. The narrower precursor to GHA029, kept because checkout is the most common unpinned action.

### GHA022 — Job without timeout-minutes

**Severity:** info

Flags jobs that omit \`timeout-minutes\`. A hung step otherwise runs to the runner's default cap, burning minutes — set an explicit ceiling.

### GHA023 — Deprecated set-output command

**Severity:** warning

Flags \`::set-output\` in \`run:\` steps. The workflow command is deprecated and disabled on current runners — write to \`$GITHUB_OUTPUT\` instead.

### GHA024 — Missing concurrency for deploy workflows

**Severity:** info

Flags deploy workflows without a \`concurrency:\` block. Without one, two pushes can deploy concurrently and race — add a concurrency group to serialize them.

### GHA025 — pull_request_target without restrictions

**Severity:** warning

Flags \`pull_request_target\` used without a \`types:\` filter. The trigger runs with repository secrets in the base-branch context, so it should be scoped to the specific PR events that need it.

### GHA026 — Secret used without environment protection

**Severity:** info

Flags workflows that reference \`secrets.\` in steps but declare no \`environment:\` on any job, so the secret skips the approval and scoping rules an environment gate provides.

### GHA027 — Cleanup step missing if: always()

**Severity:** info

Flags steps named "cleanup" / "teardown" / "clean up" that lack an \`if:\` condition. Cleanup should run even when a prior step fails — add \`if: always()\`.

### GHA028 — Workflow with no on: triggers

**Severity:** error

Flags a workflow file with no top-level \`on:\` key. Without a trigger the workflow can never run.

## Supply-chain security pass (GHA029–058)

GHA029 onward are a CI/CD supply-chain security pass: pin & vet external references, enforce least-privilege token scopes, guard trust boundaries against untrusted input, contain secrets, reject unsound expressions, and keep artifacts/caches honest. They run statically on the emitted YAML — everything answerable without leaving the build.

The checks that need a *moving external truth* — whether a pinned SHA still maps to a real upstream tag, whether a ref still exists, whether a new advisory now covers an action in use — can't be deterministic, so they live in the operational layer instead. Schedule the [\`WorkflowAuditOp\`](/chant/guide/ops/#audit-supply-chain-drift) (temporal lexicon) for that live, always-fresh half; it reads the same emitted workflow references and reports drift via \`report | issue | pull-request\`.

### GHA029 — Action or reusable workflow not pinned to a commit SHA

**Severity:** warning

Flags any \`uses:\` — step action or job-level reusable workflow — pinned to a mutable tag or branch instead of a full commit SHA. Tags can be repointed to malicious code after review, so every external reference should be pinned. \`actions/checkout\` is covered by the more specific GHA021; local (\`./\`) and \`docker://\` references are out of scope. Owners in the vendored trusted allowlist are exempt.

### GHA030 — Container image not pinned to a digest

**Severity:** warning

Flags job \`container:\` images, \`services:\` images, and \`docker://\` step references that are not pinned to an immutable \`@sha256:\` digest. A mutable tag can be repointed to a different image after review.

### GHA031 — Action resembles a well-known action

**Severity:** warning

Flags a \`uses:\` slug that is a near-miss (edit distance 1–2) of a popular action but not an exact match — a likely typo or impersonation under different ownership. Advisory; backed by a vendored reference list.

### GHA032 — Archived or compromised action

**Severity:** warning

Flags a \`uses:\` slug that a vendored snapshot marks as archived/abandoned or carrying a disclosed security issue, with remediation. Advisory and necessarily incomplete.

### GHA033 — Blanket write-all permissions

**Severity:** warning

Flags \`permissions: write-all\` at the workflow or job level. It grants the \`GITHUB_TOKEN\` every write scope regardless of need — replace it with the specific scopes the job uses.

### GHA034 — Write permissions granted workflow-wide

**Severity:** warning

Flags individual write scopes declared at the workflow level, which apply to every job even when only one needs them. Move each write scope onto the specific job that uses it. (The \`write-all\` preset is covered by GHA033.)

### GHA035 — Elevated scope on an untrusted-code trigger

**Severity:** error

Flags a workflow that grants the token write access while using a trigger that can run untrusted code (\`pull_request_target\`, \`workflow_run\`). An injected step would run with standing write credentials — drop the write scope or isolate the privileged work in a separate trusted workflow.

### GHA036 — Untrusted input in a run: command

**Severity:** error

Flags an attacker-controllable expression context (PR title, branch name, issue/comment body, commit message) interpolated directly into a \`run:\` script — a script-injection sink. Pass the value through an \`env:\` variable and reference it quoted instead.

### GHA037 — Untrusted input written to GITHUB_ENV / GITHUB_PATH

**Severity:** error

Flags a \`run:\` step that writes untrusted input into \`$GITHUB_ENV\` or \`$GITHUB_PATH\`, which set environment/PATH state for later steps and can escalate into takeover of a subsequent privileged step.

### GHA038 — workflow_run trigger checking out untrusted code

**Severity:** warning

Generalizes GHA018 to the \`workflow_run\` trigger, which runs with repo write scope and secrets. Checking out the head/artifact of the triggering run pulls untrusted code into that privileged context.

### GHA039 — Authorization gate on a spoofable identity

**Severity:** warning

Flags an \`if:\` condition that gates on a commit-author identity field (\`author.name\` / \`author.email\`). Those come from git metadata the committer sets freely and can be spoofed — gate on a verified signal (environment protection, CODEOWNERS, verified actor).

### GHA040 — Self-hosted runner on an untrusted-code trigger

**Severity:** warning

Flags a job on a self-hosted runner under a trigger a fork can reach (\`pull_request\`, \`pull_request_target\`, \`workflow_run\`). Self-hosted runners are non-ephemeral and shared, so untrusted code can persist and compromise later jobs.

### GHA041 — Blanket secrets: inherit into a reusable workflow

**Severity:** warning

Flags a reusable-workflow call passing \`secrets: inherit\`, which hands the called workflow every caller secret. Pass through only the specific secrets it needs.

### GHA042 — Entire secrets context passed

**Severity:** warning

Flags \`toJSON(secrets)\` passed into a step or reusable workflow, serializing every secret where one or two specific references would do.

### GHA043 — Secret consumed without an environment gate

**Severity:** warning

Extends GHA026: when a workflow gates some jobs with an \`environment:\`, flags the specific secret-using jobs that have none — the inconsistent-gating case where a job skips the approval/scoping applied elsewhere.

### GHA044 — Hardcoded registry/container credential

**Severity:** error

Flags a \`password:\` / \`token:\` / \`registry-password:\` set to a literal rather than a \`\${{ secrets.* }}\` reference. Move the credential into a secret.

### GHA045 — Secret interpolated into a run: command

**Severity:** warning

Flags \`\${{ secrets.* }}\` expanded directly into a \`run:\` script, where a transform can defeat log masking and the raw value is exposed to argument injection. Pass it through an \`env:\` variable and reference \`"$VAR"\` quoted.

### GHA046 — Logically unsound guard condition

**Severity:** warning

Flags an \`if:\` condition that reads like a gate but evaluates to a constant — \`true\`/\`false\` literals, an \`X == X\` tautology, or a collapse via \`|| true\` / \`&& false\`. A gate that constrains nothing is misleading.

### GHA047 — Ineffective contains() guard

**Severity:** warning

Flags \`contains('literal', <dynamic>)\` — a constant haystack with a dynamic needle. \`contains(search, item)\` tests whether \`item\` is in \`search\`, so reversed arguments make the result depend on a fixed string. Swap them.

### GHA048 — Obfuscated guard condition

**Severity:** warning

Flags an \`if:\` gate whose compared operand is built through \`format()\` / \`join()\` / \`fromJSON()\` indirection. Constructing the operand at evaluation time hides what the gate checks — compare against the value directly.

### GHA049 — Persisted checkout credentials reachable by an artifact

**Severity:** warning

Flags a job that checks out with persisted credentials (the default) and uploads an artifact — the token in \`.git/config\` can be swept into the artifact. Set \`persist-credentials: false\` on the checkout.

### GHA050 — Cache populated in a privileged context

**Severity:** warning

Flags \`actions/cache\` under a privileged trigger (\`pull_request_target\`, \`workflow_run\`). A cache entry influenced by a fork can be restored and executed by a later trusted run (cache poisoning) — restrict caching to trusted triggers.

### GHA051 — Publish step using a long-lived token instead of OIDC

**Severity:** info

Flags a publish/release job that uses a long-lived token secret while requesting no \`id-token: write\`. If the registry supports OIDC, mint a short-lived federated credential per run instead of holding a standing token.

### GHA052 — Software fetched and piped to a shell

**Severity:** warning

Flags a \`run:\` step that pipes a network download straight into a shell (\`curl ... | bash\`). The fetched code is unpinned and unverified — download to a file, verify a checksum/signature, then run it.

### GHA053 — Unsafe set-env / add-path opt-in

**Severity:** error

Flags re-enabling the \`set-env\` / \`add-path\` workflow commands removed for security (CVE-2020-15228) via \`ACTIONS_ALLOW_UNSECURE_COMMANDS\` or direct \`::set-env::\` / \`::add-path::\`. Use the \`$GITHUB_ENV\` / \`$GITHUB_PATH\` files instead.

### GHA054 — Known-bad feature usage

**Severity:** warning

Catch-all, data-driven check flagging emitted content matching a vendored snapshot of risky features (deprecated workflow commands, unsafe runtime opt-ins). Advisory and necessarily incomplete.

### GHA055 — Redundant runtime tool install

**Severity:** info

Flags a \`run:\` step that installs a tool GitHub-hosted runners already ship. The redundant install adds supply-chain surface for no benefit (irrelevant on self-hosted runners that may lack the tool).

### GHA056 — Workflow without a name

**Severity:** info

Flags a workflow with no top-level \`name:\`. Without one, GitHub falls back to the file path in the UI and audit logs, making runs harder to identify.

> Two items from issue #295 are intentionally not implemented at the post-synth layer: over-broad/unrevoked app-installation tokens (whether a minted token is scoped wider than used cannot be determined from emitted YAML) and a reference allowlist/denylist policy (configuration, overlapping the GHA029 trusted-owner allowlist).

### GHA057 — Dependency update executes untrusted code

**Severity:** error

Flags a Dependabot \`updates:\` entry with \`insecure-external-code-execution: allow\`, which runs a freshly-pulled dependency's lifecycle scripts during the update itself — a compromised release executes before any review. Set it to \`deny\`. Requires the \`Dependabot\` resource so the config is emitted (\`.github/dependabot.yml\`).

### GHA058 — Dependency update without a cooldown

**Severity:** warning

Flags a Dependabot \`updates:\` entry with no cooldown — a version published moments ago (including a compromised one) is adopted immediately. Configure a \`cooldown:\` window. The \`Dependabot\` composite ships a 7-day default.

## Running lint

\`\`\`bash
# Lint your chant project
chant lint src/

# Lint with auto-fix where supported
chant lint --fix src/
\`\`\`

To suppress a rule on a specific line:

\`\`\`typescript
// chant-disable-next-line GHA001
new Step({ uses: "actions/checkout@v4" });
\`\`\`

To suppress globally in \`chant.config.ts\`:

\`\`\`typescript
export default {
  lint: {
    rules: {
      GHA014: "off",
    },
  },
};
\`\`\``,
      },
      {
        slug: "examples",
        title: "Examples",
        description: "Walkthrough of GitHub Actions examples — workflows, composites, and patterns",
        content: `Runnable examples live in the lexicon's \`examples/\` directory. Clone the repo and try them:

\`\`\`bash
cd examples/getting-started
npm install
chant build    # produces .github/workflows/ci.yml
chant lint     # runs lint rules
npx vitest run    # run the tests
\`\`\`

## Getting Started

\`examples/getting-started/\` — a CI workflow with build and test steps for a Node.js project.

\`\`\`
src/
└── ci.ts    # Workflow + Job definitions
\`\`\`

### Source

{{file:getting-started/src/ci.ts}}

### Generated output

\`chant build\` produces \`.github/workflows/ci.yml\`:

\`\`\`yaml
name: CI
on:
  push:
    branches:
      - main
  pull_request:
    branches:
      - main
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm
      - name: Install
        run: npm ci
      - name: Build
        run: npm run build
      - name: Test
        run: npm test
\`\`\`

**Patterns demonstrated:**

1. **Typed composites** — \`Checkout({})\` and \`SetupNode({...})\` instead of raw \`uses:\` strings
2. **Permissions** — explicit \`contents: read\` following least-privilege
3. **Timeout** — \`timeoutMinutes: 15\` prevents runaway jobs
4. **Trigger scoping** — push and PR on \`main\` only`,
      },
      {
        slug: "skills",
        title: "AI Skills",
        description: "AI agent skills bundled with the GitHub Actions lexicon",
        content: `The GitHub Actions lexicon ships AI skills that teach AI coding agents (like Claude Code) how to build, validate, and deploy GitHub Actions workflows from a chant project.

## What are skills?

Skills are structured markdown documents bundled with a lexicon. When an AI agent works in a chant project, it discovers and loads relevant skills automatically — giving it operational knowledge about the deployment workflow without requiring the user to explain each step.

## Installation

When you scaffold a new project with \`chant init --lexicon github\`, skills are installed to \`.claude/skills/\` for automatic discovery by Claude Code.

For existing projects, create the files manually:

\`\`\`
.claude/
  skills/
    chant-github/
      SKILL.md    # skill content
\`\`\`

## Skill: chant-github

The inline \`chant-github\` skill covers the full workflow lifecycle:

- **Build** — \`chant build src/ --output .github/workflows/ci.yml\`
- **Validate** — \`chant lint src/\`
- **Deploy** — commit and push the generated YAML
- **Status** — GitHub Actions UI or \`gh run list\`
- **Troubleshooting** — lint rule codes (GHA001–GHA020), post-synth checks (GHA006–GHA058)

The skill is invocable as a slash command: \`/chant-github\`

## Skill: github-actions-patterns

A file-based skill loaded from \`src/skills/github-actions-patterns.md\`. It provides pattern knowledge for:

- **Workflow structure** — name, on, permissions, jobs
- **Trigger patterns** — push, pull_request, schedule, workflow_dispatch
- **Matrix strategy** — multi-OS, multi-version builds
- **Caching** — SetupNode cache option, CacheAction composite
- **Permissions** — least-privilege patterns
- **Reusable workflows** — ReusableWorkflowCallJob
- **Artifacts** — upload/download between jobs
- **Concurrency** — group + cancel-in-progress

## MCP integration

The lexicon provides MCP (Model Context Protocol) tools and resources that AI agents can use programmatically:

| MCP tool | Description |
|----------|-------------|
| \`diff\` | Compare current build output against previous output |
| \`github:checks\` | Build the workflow and return its security findings (the GHA checks) |
| \`github:workflow\` | Triggers and jobs as written — name, run order, step count |
| \`github:references\` | Actions and images pulled in, and whether each is pinned to a commit SHA |
| \`github:affected\` | Given a job, the jobs that would re-run because they depend on it |
| \`github:workflow-yaml\` | The generated workflow YAML |

The \`github:*\` tools are **read-only context tools** (#327): each builds from your source and returns what chant already computes — before the workflow runs or merges. None touch the live GitHub instance, run history, or write anything.

| MCP resource | Description |
|--------------|-------------|
| \`resource-catalog\` | JSON list of all supported GitHub Actions entity types |
| \`examples/basic-ci\` | Example CI workflow with TypeScript source |`,
      },
    ],
    basePath: "/chant/lexicons/github/",
  };

  const result = await docsPipeline(config);
  writeDocsSite(config, result);

  if (opts?.verbose) {
    console.error(
      `Generated docs: ${result.stats.resources} resources, ${result.stats.properties} properties, ${result.stats.services} services, ${result.stats.rules} rules`,
    );
  }
}
