# Docker Dev

Containerized local development using Docker provisioner for automatic PostgreSQL container management, with both versioned and repeatable migrations for views and functions.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `chant init --lexicon flyway`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-flyway` | `@intentius/chant-lexicon-flyway` | Flyway project lifecycle: build, lint, configure, migrate, troubleshooting |

> **Using Claude Code?** Just ask:
>
> ```
> Build the docker-dev Flyway project.
> ```

## What this produces

A `flyway.toml` configuration file with Docker-provisioned dev and shadow environments on separate ports, migration locations for both versioned and repeatable SQL files, and a BlueprintMigrationSet defining four versioned migrations plus two repeatable migrations for views and functions.

## Source files

| File | Description |
|------|-------------|
| `src/infra.ts` | Defines FlywayProject, FlywayConfig with mixed migration support, two DockerDevEnvironment composites (dev on port 5433, shadow on port 5434), and a BlueprintMigrationSet with versioned and repeatable migrations |

## Prerequisites

- [Node.js](https://nodejs.org/) >= 22
- [Flyway CLI](https://documentation.red-gate.com/fd/command-line-184127404.html)

## Build

```bash
npm install && npm run build && npm run lint
```

## Related examples

- [basic-project](../basic-project/) — Minimal single-environment Flyway project
- [desktop-project](../desktop-project/) — Flyway Desktop pattern with dev and shadow databases
- [migration-lifecycle](../migration-lifecycle/) — Full end-to-end migration walkthrough with Docker databases

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`
