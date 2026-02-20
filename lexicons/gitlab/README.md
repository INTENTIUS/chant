# @intentius/chant-lexicon-gitlab

GitLab CI lexicon for [chant](https://intentius.io/chant/) — declare CI/CD pipelines as typed TypeScript that serializes to `.gitlab-ci.yml`.

This package provides typed constructors for all GitLab CI keywords (Jobs, Workflows, Defaults, and property types like Artifacts, Cache, Image, Rule, Environment, and Trigger), the `CI` pseudo-parameter object for predefined variables, the `reference()` intrinsic for YAML `!reference` tags, and GitLab-specific lint rules. It also includes LSP and MCP server support for editor completions and hover.

```bash
npm install --save-dev @intentius/chant @intentius/chant-lexicon-gitlab
```

**[Documentation →](https://intentius.io/chant/lexicons/gitlab/)**

## Related Packages

| Package | Role |
|---------|------|
| [@intentius/chant](https://www.npmjs.com/package/@intentius/chant) | Core type system, CLI, build pipeline |
| [@intentius/chant-lexicon-aws](https://www.npmjs.com/package/@intentius/chant-lexicon-aws) | AWS CloudFormation lexicon |

## License

See the main project LICENSE file.
