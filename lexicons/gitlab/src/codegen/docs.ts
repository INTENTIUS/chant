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
    // "intrinsics" is no longer suppressed (chant #1067) — the reference
    // table at that slug is now generated from the plugin's own
    // `intrinsics()` registration (docsPipeline's generateIntrinsics, same
    // mechanism azure/helm already use), so its "Folds?" column can never
    // drift from the registration the way #1062's foldability matrix
    // depends on. The hand-written `reference()` usage guide lives in a
    // separate "intrinsics-guide" page under docs/pages/ — content unchanged,
    // just no longer sharing a slug with generated data.
    examplesDir: join(pkgDir, "examples"),
    extraSections: [
      {
        title: "Migrating from GitHub Actions",
        content: `\`chant migrate\` translates GitHub Actions workflows into GitLab CI/CD pipelines or typed chant source. See [Migration](./migration) for the full CLI surface, supported translations, and limitations.`,
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
