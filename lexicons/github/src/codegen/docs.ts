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

The lexicon provides **3 resources** (Workflow, Job, Dependabot config), **14 composites** (Checkout, SetupNode, SetupGo, SetupPython, CacheAction, UploadArtifact, DownloadArtifact, NodeCI, NodePipeline, PythonCI, DockerBuild, DeployEnvironment, GoCI, Dependabot) + **3 presets** (BunPipeline, PnpmPipeline, YarnPipeline), a typed **Expression** system with 24 GitHub and 5 Runner context variables, and **13 lint rules** + **49 post-synth checks** (including a CI/CD supply-chain security pass, GHA029–062).
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
    suppressPages: ["intrinsics"],
    examplesDir: join(pkgDir, "examples"),
    extraSections: [
      {
        title: "Migrating to GitLab CI/CD?",
        content: `The GitLab lexicon ships a typed-compiler migration tool that translates \`.github/workflows/*.yml\` into \`.gitlab-ci.yml\` (or chant TypeScript) with provenance, 33 curated marketplace-action mappings, and optional composite recognition. See [GitLab → Migration from GitHub Actions](/chant/lexicons/gitlab/migration/) or the [\`chant migrate\` CLI reference](/chant/cli/migrate/).`,
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
