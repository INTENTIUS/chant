# @intentius/chant

Core package for [chant](https://intentius.io/chant/) — a type system for operations.

This package provides the lexicon-agnostic foundation that all chant lexicons build on. It includes the type system (Declarables, Intrinsics, Parameters, Outputs), the discovery and build pipeline, the semantic lint engine, the CLI, template import, and reusable codegen infrastructure for lexicon authors (runtime factories, naming strategies, generation and packaging pipelines, LSP providers).

Install it alongside a lexicon to start declaring infrastructure as typed TypeScript.

```bash
npm install --save-dev @intentius/chant @intentius/chant-lexicon-aws
```

**[Documentation →](https://intentius.io/chant/getting-started/introduction/)**

## Related Packages

| Package | Role |
|---------|------|
| [@intentius/chant-lexicon-aws](https://www.npmjs.com/package/@intentius/chant-lexicon-aws) | AWS CloudFormation lexicon |
| [@intentius/chant-lexicon-gitlab](https://www.npmjs.com/package/@intentius/chant-lexicon-gitlab) | GitLab CI lexicon |

## License

See the main project LICENSE file.
