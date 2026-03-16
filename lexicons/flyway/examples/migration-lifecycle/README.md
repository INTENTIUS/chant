# Migration Lifecycle

Full end-to-end Flyway example: start a database, build config from chant, and apply V1 -> V2 -> V3 migrations with `environmentGroup` inheritance.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `chant init --lexicon flyway`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-flyway` | `@intentius/chant-lexicon-flyway` | Flyway project lifecycle: build, lint, configure, migrate, troubleshooting |

> **Using Claude Code?** Just ask:
>
> ```
> Build the migration-lifecycle Flyway project.
> ```

## What this produces

A `flyway.toml` configuration file with three environments (dev, shadow, prod) generated from an `environmentGroup`. Shared config is deep-merged per environment: dev allows clean and uses debug logging, shadow uses the clean provisioner for fresh-start validation, and prod uses env-var credentials with strict validation.

## Source files

| File | Description |
|------|-------------|
| `src/infra.ts` | Defines FlywayProject, FlywayConfig, and an environmentGroup with deep-merge inheritance for dev (clean-enabled, debug), shadow (clean provisioner), and prod (env-var creds, strict validation) |

## Prerequisites

- [Bun](https://bun.sh) or [Node.js](https://nodejs.org/) >= 22
- [Docker](https://docs.docker.com/get-docker/)
- [Flyway CLI](https://documentation.red-gate.com/fd/command-line-184127404.html)

## Build

```bash
bun install && bun run build && bun run lint
```

## Related examples

- [environment-overrides](../environment-overrides/) — Per-environment config overrides with environmentGroup
- [docker-dev](../docker-dev/) — Docker-based local development with versioned and repeatable migrations
- [multi-environment](../multi-environment/) — Four-environment setup using the MultiEnvironmentProject composite

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`
