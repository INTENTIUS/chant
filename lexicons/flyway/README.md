# @intentius/chant-lexicon-flyway

Flyway lexicon for [chant](https://intentius.io/chant/) — declare database migration configuration as typed TypeScript that serializes to `flyway.toml`.

This package provides typed constructors for Flyway projects, environments, resolvers (Vault, GCP, Dapr, etc.), provisioners (Docker, Clean, Snapshot, etc.), desktop config, composites for common patterns, and Flyway-specific lint rules. It also includes LSP and MCP server support for editor completions and hover.

```bash
npm install --save-dev @intentius/chant @intentius/chant-lexicon-flyway
```

**[Documentation →](https://intentius.io/chant/lexicons/flyway/)**

## Related Packages

| Package | Role |
|---------|------|
| [@intentius/chant](https://www.npmjs.com/package/@intentius/chant) | Core type system, CLI, build pipeline |
| [@intentius/chant-lexicon-aws](https://www.npmjs.com/package/@intentius/chant-lexicon-aws) | AWS CloudFormation lexicon |
| [@intentius/chant-lexicon-gitlab](https://www.npmjs.com/package/@intentius/chant-lexicon-gitlab) | GitLab CI lexicon |
| [@intentius/chant-lexicon-k8s](https://www.npmjs.com/package/@intentius/chant-lexicon-k8s) | Kubernetes lexicon |

## License

See the main project LICENSE file.
