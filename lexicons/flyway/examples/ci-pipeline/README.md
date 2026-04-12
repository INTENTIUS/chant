# CI Pipeline

CI/CD integration with environment-variable-based credentials, baseline-on-migrate for initial deployments, and strict migration validation using the CiPipelineProject composite.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `chant init --lexicon flyway`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-flyway` | `@intentius/chant-lexicon-flyway` | Flyway project lifecycle: build, lint, configure, migrate, troubleshooting |

> **Using Claude Code?** Just ask:
>
> ```
> Build the ci-pipeline Flyway project.
> ```

## What this produces

A `flyway.toml` configuration file with three environments (ci, staging, prod). All environments use environment-variable-based credentials via the `env` intrinsic, with baseline-on-migrate enabled for initial schema bootstrapping.

## Source files

| File | Description |
|------|-------------|
| `src/infra.ts` | Defines a CiPipelineProject composite with env-var prefix, plus additional staging and prod environments with stricter production settings |

## Prerequisites

- [Node.js](https://nodejs.org/) >= 22
- [Flyway CLI](https://documentation.red-gate.com/fd/command-line-184127404.html)

## Build

```bash
npm install && npm run build && npm run lint
```

## Related examples

- [environment-overrides](../environment-overrides/) — Per-environment config overrides with shared base settings
- [multi-environment](../multi-environment/) — Four-environment setup with shadow database
- [docker-dev](../docker-dev/) — Containerized local development with Docker provisioner

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`
