# @intentius/chant-lexicon-docker

Docker lexicon for [chant](https://intentius.io/chant/) — declare Docker Compose services and Dockerfile build instructions as typed TypeScript that serializes to `docker-compose.yml` and `Dockerfile.*` files.

Provides typed constructors for Service, Volume, Network, Config, Secret, and multi-stage Dockerfile resources, plus variable interpolation, default labels, Docker-specific lint rules, LSP completions, and MCP server support.

```bash
npm install --save-dev @intentius/chant @intentius/chant-lexicon-docker
```

**[Documentation →](https://intentius.io/chant/lexicons/docker/)**

## Related Packages

| Package | Role |
|---------|------|
| [@intentius/chant](https://www.npmjs.com/package/@intentius/chant) | Core type system, CLI, build pipeline |
| [@intentius/chant-lexicon-k8s](https://www.npmjs.com/package/@intentius/chant-lexicon-k8s) | Kubernetes lexicon |
| [@intentius/chant-lexicon-aws](https://www.npmjs.com/package/@intentius/chant-lexicon-aws) | AWS CloudFormation lexicon |
| [@intentius/chant-lexicon-flyway](https://www.npmjs.com/package/@intentius/chant-lexicon-flyway) | Flyway database migrations lexicon |

## License

See the main project LICENSE file.
