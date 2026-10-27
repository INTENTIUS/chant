# @intentius/chant-lexicon-terraform

Terraform and OpenTofu lexicon for [chant](https://github.com/intentius/chant).
It reads your roots as they are, and runs them on terraform, tofu or
[choudoufu](https://github.com/INTENTIUS/choudoufu), an OpenTofu fork that
keeps ownership as markers on the resources.

This lexicon reads the HCL an estate already has, where other lexicons
generate typed resource classes from an upstream schema. Name your root modules in
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
    binary: "terraform", // or "tofu", or "choudoufu" for ownership markers
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

## Acceptance evidence

Eleven `describe` blocks across eight files run this lexicon against a real
`terraform`, `tofu`, `choudoufu` or `terragrunt` binary, and each of them
skips rather than fails when its dependency is absent.
`src/__fixtures__/ACCEPTANCE.md` records, per block, what it proves, what
gates it, the command that runs it, and a "Last passed" line: the binary,
emulator and date of its last recorded pass. Eight blocks have one. The three
Terragrunt suites read "not recorded" until their first run is written down.
