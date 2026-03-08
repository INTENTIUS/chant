# Basic Project

Minimal single-environment PostgreSQL Flyway project with versioned migrations — an introductory example of FlywayProject, FlywayConfig, and Environment primitives.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `chant init --lexicon flyway`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-flyway` | `@intentius/chant-lexicon-flyway` | Flyway project lifecycle: build, lint, configure, migrate, troubleshooting |

> **Using Claude Code?** Just ask:
>
> ```
> Build the basic-project Flyway project.
> ```

## What this produces

A `flyway.toml` configuration file with a single dev environment pointing at a local PostgreSQL database, with clean provisioner enabled for fast iteration.

## Source files

| File | Description |
|------|-------------|
| `src/infra.ts` | Defines FlywayProject, FlywayConfig with PostgreSQL defaults, and a single dev Environment with clean provisioner |

## Prerequisites

- [Bun](https://bun.sh) or [Node.js](https://nodejs.org/) >= 22
- [Flyway CLI](https://documentation.red-gate.com/fd/command-line-184127404.html)

## Build

```bash
bun install && bun run build && bun run lint
```

## Related examples

- [docker-dev](../docker-dev/) — Containerized local development with Docker provisioner
- [multi-environment](../multi-environment/) — Four-environment setup with shadow database
- [callbacks](../callbacks/) — Lifecycle callbacks for audit logging and notifications

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`
