# @intentius/chant-lexicon-k3s

k3s lexicon for [chant](https://github.com/intentius/chant) — the k3s
distro's host configuration as declarable data.

Declares the files k3s itself consumes: `config.yaml` for `k3s server` /
`k3s agent` (every CLI flag as a YAML key, typed from the pinned release's
own flag definitions), and `registries.yaml` for the embedded containerd.
The emitted files are exactly what the native tool accepts.

The join token is deliberately not declarable: the surface carries only the
reference forms (`token-file`, `agent-token-file`), and K3S001/K3S101 fail
a literal that arrives anyway.

## Getting started

```bash
# Generate types from the pinned k3s release (v1.36.3+k3s1)
npm run generate

# Validate generated artifacts
npm run validate

# Tests (the Docker-gated acceptance test boots rancher/k3s on the emitted config)
npx vitest run lexicons/k3s
```

## Project structure

- `src/plugin.ts` — LexiconPlugin with all lifecycle methods
- `src/serializer.ts` — config.yaml / registries.yaml emitter
- `src/spec/fetch.ts` — pinned upstream sources (the CLI flag definitions)
- `src/codegen/parse.ts` — Go flag-definition parser
- `src/lint/` — K3S001 pre-synth rule, K3S101–K3S107 post-synth checks
- `src/lsp/` — completions and hover from the generated registry
- `src/generated/` — generated artifacts (do not edit)
