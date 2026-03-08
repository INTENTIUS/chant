# Callbacks

Flyway lifecycle callbacks (beforeMigrate, afterMigrate, afterMigrateError, beforeValidate, afterClean) for audit logging and notifications using BlueprintMigrationSet.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `chant init --lexicon flyway`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-flyway` | `@intentius/chant-lexicon-flyway` | Flyway project lifecycle: build, lint, configure, migrate, troubleshooting |

> **Using Claude Code?** Just ask:
>
> ```
> Build the callbacks Flyway project.
> ```

## What this produces

A `flyway.toml` configuration file with dev and prod environments, callback locations for SQL lifecycle hooks, and a BlueprintMigrationSet defining four versioned migrations and five callback events.

## Source files

| File | Description |
|------|-------------|
| `src/infra.ts` | Defines FlywayProject, FlywayConfig with callbackLocations, dev/prod environments, and a BlueprintMigrationSet with versioned migrations and CallbackEvent hooks |

## Prerequisites

- [Bun](https://bun.sh) or [Node.js](https://nodejs.org/) >= 22
- [Flyway CLI](https://documentation.red-gate.com/fd/command-line-184127404.html)

## Build

```bash
bun install && bun run build && bun run lint
```

## Related examples

- [basic-project](../basic-project/) — Minimal single-environment Flyway project
- [docker-dev](../docker-dev/) — Docker-based dev with versioned and repeatable migrations
- [migration-lifecycle](../migration-lifecycle/) — Full end-to-end migration walkthrough with Docker

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`
