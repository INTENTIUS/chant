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

The lexicon provides **2 resources** (Workflow, Job), **13 composites** (Checkout, SetupNode, SetupGo, SetupPython, CacheAction, UploadArtifact, DownloadArtifact, NodeCI, NodePipeline, PythonCI, DockerBuild, DeployEnvironment, GoCI) + **3 presets** (BunPipeline, PnpmPipeline, YarnPipeline), a typed **Expression** system with 24 GitHub and 5 Runner context variables, and **13 lint rules** + **6 post-synth checks**.
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
- [Lint Rules](/chant/lexicons/github/lint-rules/) — 13 lint rules and 6 post-synth checks`,
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

**Props:** \`goVersion?\`, \`testCommand?\`, \`buildCommand?\`, \`lintCommand?\` (null to omit), \`runsOn?\``,
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

### GHA017 — Missing permissions block

**Severity:** info

Flags workflows without an explicit \`permissions:\` block. Omitting permissions uses the repository default (often overly broad). Following least-privilege by declaring explicit permissions is a security best practice.

### GHA018 — pull_request_target with checkout

**Severity:** warning

Flags workflows triggered by \`pull_request_target\` that include \`actions/checkout\`. This combination can be a security risk because the workflow runs with write permissions in the context of the base branch while checking out potentially untrusted PR code.

### GHA019 — Circular needs chain

**Severity:** error

Detects cycles in the \`needs:\` dependency graph. If job A needs B and B needs A (directly or transitively), GitHub rejects the workflow. Reports the full cycle chain in the diagnostic message.

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
- **Troubleshooting** — lint rule codes (GHA001–GHA020), post-synth checks (GHA006–GHA019)

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
