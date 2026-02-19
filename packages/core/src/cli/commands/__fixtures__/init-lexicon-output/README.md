# @intentius/chant-lexicon-fixture

fixture lexicon plugin for [chant](https://github.com/intentius/chant).

## Getting started

```bash
# Generate types from upstream spec
just generate

# Validate generated artifacts
just validate

# Generate documentation
just docs
```

## Project structure

- `src/plugin.ts` — LexiconPlugin with all lifecycle methods
- `src/serializer.ts` — Build output serializer
- `src/codegen/` — Code generation pipeline
- `src/spec/` — Upstream schema fetching and parsing
- `src/lint/rules/` — Lint rules
- `src/lsp/` — LSP completions and hover
- `src/generated/` — Generated artifacts (do not edit)
