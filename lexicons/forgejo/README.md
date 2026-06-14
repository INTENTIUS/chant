# @intentius/chant-lexicon-forgejo

Forgejo Actions lexicon for [chant](https://intentius.io/chant) — a **thin
dialect of the github lexicon**. Forgejo (the forge behind Codeberg,
self-hosted Forgejo, and Gitea) runs GitHub-Actions-compatible workflows, so
this package reuses the github lexicon's entities and composites wholesale and
overrides only what the dialect changes.

## What it does

You author exactly as you would for GitHub Actions — same `Workflow`, `Job`,
`Step`, and composites, imported from `@intentius/chant-lexicon-forgejo`:

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

On build, the Forgejo dialect:

- **Drops keys Forgejo ignores** — `permissions` and `continue-on-error` are
  silently ignored by the Forgejo runner, so they are removed from the output
  and reported as build warnings (emitting them is misleading).
- **Maps runner labels** — GitHub-hosted labels like `ubuntu-latest` have no
  fixed meaning on Forgejo. They are mapped to a default Forgejo label
  (`docker`), overridable per project. Unmapped labels pass through with a
  warning.
- **Resolves `uses:` action refs** — Forgejo has no GitHub Marketplace, so a
  bare `uses: actions/checkout@v4` is rewritten to a resolvable form. Common
  `actions/*` are mapped under an actions root (`https://code.forgejo.org` by
  default, overridable via `forgejo.actionsRoot`); `docker/*` are pinned to
  their full GitHub URL. Local (`./…`), `docker://`, and full-URL refs pass
  through untouched. Anything else passes through **and is reported** as a
  warning so it's never silently unresolvable.

Everything else is emitted by the github serializer, which already produces the
exact YAML shape Forgejo executes.

## Building

Forgejo reads workflows from `.forgejo/workflows/` (and `.gitea/workflows/` for
Gitea), so point the build output there:

```sh
chant build src -o .forgejo/workflows/ci.yml
```

## Configuration

Override runner-label mapping in `chant.config.ts`:

```ts
import type { ChantConfig } from "@intentius/chant";

export default {
  lexicons: ["forgejo"],
  forgejo: {
    runnerLabels: {
      "ubuntu-latest": "docker",
      "ubuntu-22.04": "ubuntu-lts",
    },
    // Base for resolving mirrored `uses:` action refs.
    actionsRoot: "https://code.forgejo.org",
  },
} satisfies ChantConfig;
```

## Notes

- The serializer's lexicon `name` is `"github"` on purpose: it serializes the
  reused github-lexicon entities (which are tagged `lexicon: "github"`). Its
  rule prefix is `WFJ` to keep Forgejo diagnostics namespaced apart from
  github's `GHA`.
- No codegen: this lexicon has no spec of its own. Run `chant generate` in the
  github lexicon if you need to refresh entities.
