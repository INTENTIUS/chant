import { docsPipeline, writeDocsSite } from "@intentius/chant/codegen/docs";

const DIALECT_CONTENT = `Forgejo (the forge behind Codeberg, self-hosted Forgejo, and Gitea) runs
GitHub-Actions-compatible workflows. You author exactly as you would for
GitHub Actions — same \`Workflow\`, \`Job\`, \`Step\`, and composites, imported
from \`@intentius/chant-lexicon-forgejo\` instead of the github package:

\`\`\`ts
import { Workflow, Job, Step, Checkout, SetupNode } from "@intentius/chant-lexicon-forgejo";

export const workflow = new Workflow({
  name: "CI",
  on: { push: { branches: ["main"] } },
});

export const build = new Job({
  "runs-on": "ubuntu-latest",
  steps: [
    Checkout({}).step,
    SetupNode({ nodeVersion: "22", cache: "npm" }).step,
    new Step({ name: "Test", run: "npm test" }),
  ],
});
\`\`\`

On build, the dialect:

- **Drops keys Forgejo ignores** — \`permissions\` and \`continue-on-error\` are
  silently ignored by the Forgejo runner, so they are removed from the output
  and reported as build warnings (emitting them is misleading).
- **Maps runner labels** — GitHub-hosted labels like \`ubuntu-latest\` have no
  fixed meaning on Forgejo. They are mapped to a default Forgejo label
  (\`docker\`), overridable per project. Unmapped labels pass through with a
  warning.
- **Resolves \`uses:\` action refs** — Forgejo has no GitHub Marketplace, so a
  bare \`uses: actions/checkout@v4\` is rewritten to a resolvable form. Common
  \`actions/*\` are mapped under an actions root (\`https://code.forgejo.org\` by
  default, overridable via \`forgejo.actionsRoot\`); \`docker/*\` are pinned to
  their full GitHub URL. Local (\`./...\`), \`docker://\`, and full-URL refs pass
  through untouched. Anything else passes through **and is reported** as a
  warning so it's never silently unresolvable.

Everything else is emitted by the github serializer, which already produces
the exact YAML shape Forgejo executes.

## Lint rules and editor support

Forgejo has no lint rules or LSP completions/hover of its own — a forgejo
workflow is TypeScript indistinguishable in shape from an equivalent github
one, so \`chant lint\` and editor tooling run github's checks and catalog
against forgejo source unmodified (\`completionProvider()\` and
\`hoverProvider()\` forward straight to \`githubPlugin\`'s). Lint rules are
wrapped rather than re-exported verbatim — each GHA0xx rule appears under a
\`WFJ-\` prefix (e.g. \`WFJ-GHA001\`) with its check logic untouched, so a
project (or \`chant audit\`) can load the github and forgejo plugins together
without an id collision. See the
[github lexicon's Lint Rules page](/chant/lexicons/github/lint-rules/) for
the full GHA0xx catalog.

## Migrating from GitHub Actions

Because github → forgejo YAML is near-identical, the migration is thin — it
applies the same dialect as a build. Its real value is the **compare**: what
the move costs.

\`\`\`sh
chant migrate .github/workflows/ci.yml --to forgejo -o .forgejo/workflows/ci.yml --validate
\`\`\`

\`--validate\` prints a **security posture** report classifying each property's
fate across the edge:

| Fate | Meaning |
|---|---|
| \`translated\` | carried across as-is |
| \`approximated\` | carried with a close equivalent |
| \`needs-review\` | confirm/adjust on Forgejo (unresolved \`uses:\`, unmapped runner label) |
| \`lost\` | the Forgejo runner ignores it (\`permissions\`, \`continue-on-error\`) |

The same view is available to agents as the \`forgejo:compare\` MCP tool, which
takes a workflow file and returns per-property fates plus summary counts —
read-only.
`;

const OVERVIEW_CONTENT = `\`@intentius/chant-lexicon-forgejo\` targets **Forgejo Actions** — the CI behind
[Codeberg](https://codeberg.org), self-hosted [Forgejo](https://forgejo.org),
and [Gitea](https://about.gitea.com). Forgejo runs **GitHub-Actions-compatible**
workflows, so the lexicon is a **thin dialect of the [github lexicon](/chant/lexicons/github/)**
(chant #338): every entity, composite, and expression helper is the same class
you'd import from the github package. This package supplies only what is
genuinely Forgejo-specific — the serializer dialect and a github → forgejo
migration path. One package covers Codeberg, self-hosted Forgejo, and Gitea.

Author exactly as you would for GitHub Actions, importing from the forgejo
package; see [The Forgejo Dialect](/chant/lexicons/forgejo/dialect/) for what
changes on the way out.

## Build

Forgejo reads workflows from \`.forgejo/workflows/\` (or \`.gitea/workflows/\` for
Gitea), so point the output there — the same way the github lexicon targets
\`.github/workflows/\`:

\`\`\`sh
chant build src -o .forgejo/workflows/ci.yml
\`\`\`

## Configuration

Override the runner-label map and the actions root in \`chant.config.ts\`:

\`\`\`ts
import type { ChantConfig } from "@intentius/chant/config";
// Brings the \`forgejo\` key into ChantConfig (chant #1344).
import "@intentius/chant-lexicon-forgejo";

export default {
  lexicons: ["forgejo"],
  forgejo: {
    runnerLabels: {
      "ubuntu-latest": "docker",
      "ubuntu-22.04": "ubuntu-lts",
    },
    actionsRoot: "https://code.forgejo.org",
  },
} satisfies ChantConfig;
\`\`\`

## Read-only context tools

The forgejo lexicon ships the full \`forgejo:*\` [read-only context tools](/chant/guide/agent-integration/#read-only-context-tools)
(\`checks\`, \`workflow\`, \`references\`, \`affected\`, \`workflow-yaml\`, \`source\`,
\`owns\`, \`compare\`). Each builds from source and returns what chant already
computes — without touching any live forge.

## Runtime observation

N/A — workflow definitions are git-tracked, so drift is a \`git diff\`, the same
rationale as the github and gitlab lexicons. The lexicon implements neither
\`describeResources()\` nor \`listArtifacts()\` and is warn-skipped on \`--live\`.

## Validating execution

A runtime E2E (\`just forgejo-runtime-e2e\`) builds a workflow and **runs** the
generated \`.forgejo/workflows/ci.yml\` in Docker via a Forgejo runner
(\`forgejo-runner\` / \`act_runner\` / \`act\` \`exec\`), proving Forgejo Actions
accepts and executes chant's output. On-demand — it needs Docker and a runner
tool, and is not part of the gating CI.

## Caveats

Flow-style YAML (\`branches: [main]\`) is parsed by chant's lightweight core
parser, which keeps it as a scalar — prefer block style in sources you intend to
migrate. This is shared with the github import path.
`;

/**
 * Generate documentation site for the Forgejo lexicon.
 */
export async function generateDocs(options?: { verbose?: boolean }): Promise<void> {
  const config = {
    name: "forgejo",
    displayName: "Forgejo",
    description: "Forgejo / Codeberg / Gitea Actions lexicon documentation — a thin GitHub Actions dialect",
    distDir: "./dist",
    outDir: "./docs",
    basePath: process.env.DOCS_BASE_PATH ?? "/chant/lexicons/forgejo/",
    overview: OVERVIEW_CONTENT,
    outputFormat:
      "The Forgejo lexicon serializes entities into the same YAML shape as GitHub Actions, then applies the Forgejo dialect (see [The Forgejo Dialect](/chant/lexicons/forgejo/dialect/)) before writing to `.forgejo/workflows/*.yml` (or `.gitea/workflows/*.yml` for Gitea).",
    extraPages: [
      {
        slug: "dialect",
        title: "The Forgejo Dialect",
        description: "What changes when a GitHub Actions workflow serializes to Forgejo, and how migration works",
        content: DIALECT_CONTENT,
      },
    ],
  };

  const result = docsPipeline(config);
  writeDocsSite(config, result);

  if (options?.verbose) {
    console.error("Documentation generated");
  }
}
