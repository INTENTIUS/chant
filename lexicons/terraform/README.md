# @intentius/chant-lexicon-terraform

Terraform lexicon plugin for [chant](https://github.com/intentius/chant).

Unlike the lexicons that generate typed resource classes from an upstream
schema, this one reads the HCL an estate already has. Name your root modules in
`chant.config.ts` and each `.tf` block joins the build as an entity, so the
post-synth checks and `chant audit` can see the root without anything being
written back over it.

```ts
// chant.config.ts
import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-terraform";

export default {
  lexicons: ["terraform"],
  terraform: {
    binary: "terraform", // or "tofu"
    roots: {
      app: { dir: "./terraform", workspace: "prod", varFiles: ["prod.tfvars"] },
    },
  },
} satisfies ChantConfig;
```

`dir` resolves against the project root, the directory holding
`chant.config.ts`. A root that does not exist, or a `.tf` the parser refuses, is
a build warning and no entities for that root, never a failure.

## Getting started

```bash
# Assemble dist/ (there is no upstream spec to fetch)
npm run bundle

# Validate the generated artifacts
just validate

# Generate the docs site
just docs
```

## Project structure

- `src/plugin.ts`, the LexiconPlugin, including the `buildRoots()` hook
- `src/config.ts`, the `terraform` config namespace and its `ChantConfig` augmentation
- `src/hcl/parse.ts`, one entity per HCL block, from a directory or from `chant audit`'s joined-file form
- `src/hcl/roots.ts`, the per-root render `buildRoots()` delegates to
- `src/serializer.ts`, a deliberate no-op: the `.tf` files are the artifact
- `src/lint/rules/`, source-level lint rules
- `src/lint/post-synth/`, checks over the parsed roots (TF001 and up)
- `src/lsp/`, LSP completions and hover
