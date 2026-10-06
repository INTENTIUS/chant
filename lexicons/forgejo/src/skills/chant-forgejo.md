# chant-forgejo

Forgejo / Codeberg / Gitea Actions with chant.

Forgejo runs **GitHub-Actions-compatible** workflows, so the forgejo lexicon is
a thin dialect of the github lexicon. You author exactly as you would for GitHub
Actions — same `Workflow`, `Job`, `Step`, and composites — but import from
`@intentius/chant-lexicon-forgejo`. The dialect applies on build.

## Authoring

```ts
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
```

## Build

Forgejo reads workflows from `.forgejo/workflows/` (or `.gitea/workflows/` for
Gitea):

```sh
chant build src -o .forgejo/workflows/ci.yml
```

## What the dialect does on build

- **Drops keys the Forgejo runner ignores** — `continue-on-error` is removed
  with a build warning. `permissions` is removed silently, except `id-token`,
  which stays for OIDC.
- **Maps runner labels** — `ubuntu-latest` → `docker` by default; override via
  `forgejo.runnerLabels` in `chant.config.ts`. Unmapped labels warn.
- **Resolves `uses:` refs** — common `actions/*` rewrite under
  `forgejo.actionsRoot` (default `https://code.forgejo.org`); `docker/*` pin to
  their GitHub URL; unmapped refs warn.

## Migrating from GitHub Actions

```sh
chant migrate .github/workflows/ci.yml --to forgejo -o .forgejo/workflows/ci.yml --validate
```

`--validate` prints a **Security posture** report: what survives the move and
what Forgejo silently drops (`continue-on-error` → lost, `permissions` → needs-review,
unresolved `uses:` / unmapped runner labels → needs-review). The same view is
the `forgejo:compare` MCP tool.

## Read-only context tools (MCP)

- `forgejo:workflow` — triggers and jobs as written
- `forgejo:references` — external actions/images and whether each is SHA-pinned
- `forgejo:affected` — jobs that re-run downstream of a given job
- `forgejo:checks` — Forgejo-specific findings (WFJ010/011)
- `forgejo:source` / `forgejo:owns` — where a job came from / whether it's declared here
- `forgejo:workflow-yaml` — the generated YAML
- `forgejo:compare` — the github→forgejo migration safety view
