# @intentius/chant-lexicon-k8s

Kubernetes lexicon for [chant](https://intentius.io/chant/) — declare infrastructure as typed TypeScript that serializes to Kubernetes YAML manifests.

This package provides typed constructors for all core Kubernetes resource types (Deployments, Services, ConfigMaps, Secrets, StatefulSets, and more), property types (Containers, Volumes, Probes, etc.), composites for common patterns, and K8s-specific lint rules. It also includes LSP and MCP server support for editor completions and hover.

```bash
npm install --save-dev @intentius/chant @intentius/chant-lexicon-k8s
```

**[Documentation →](https://intentius.io/chant/lexicons/k8s/)**

## Related Packages

| Package | Role |
|---------|------|
| [@intentius/chant](https://www.npmjs.com/package/@intentius/chant) | Core type system, CLI, build pipeline |
| [@intentius/chant-lexicon-aws](https://www.npmjs.com/package/@intentius/chant-lexicon-aws) | AWS CloudFormation lexicon |
| [@intentius/chant-lexicon-gitlab](https://www.npmjs.com/package/@intentius/chant-lexicon-gitlab) | GitLab CI lexicon |
| [@intentius/chant-lexicon-flyway](https://www.npmjs.com/package/@intentius/chant-lexicon-flyway) | Flyway migration lexicon |

## License

See the main project LICENSE file.
