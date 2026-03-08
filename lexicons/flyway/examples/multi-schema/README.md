# Multi-Schema

Multiple database schemas (public, audit, reporting) with schema-specific placeholders for cross-schema references in migrations and environment-specific remapping.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `chant init --lexicon flyway`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-flyway` | `@intentius/chant-lexicon-flyway` | Flyway project lifecycle: build, lint, configure, migrate, troubleshooting |

> **Using Claude Code?** Just ask:
>
> ```
> Build the multi-schema Flyway project.
> ```

## What this produces

A `flyway.toml` configuration file with three environments (dev, staging, prod), each managing public, audit, and reporting schemas. Includes schema-specific Placeholder resources so migrations can reference `${audit_schema}` instead of hardcoding schema names, plus application-level placeholders for retention policies and refresh intervals.

## Source files

| File | Description |
|------|-------------|
| `src/infra.ts` | Defines FlywayProject, FlywayConfig with three schema-specific migration locations, dev/staging/prod environments, and Placeholder resources for cross-schema references and application settings |

## Prerequisites

- [Bun](https://bun.sh) or [Node.js](https://nodejs.org/) >= 22
- [Flyway CLI](https://documentation.red-gate.com/fd/command-line-184127404.html)

## Build

```bash
bun install && bun run build && bun run lint
```

## Related examples

- [multi-environment](../multi-environment/) — Four-environment setup with per-environment placeholder customization
- [environment-overrides](../environment-overrides/) — Shared config deep-merged with per-environment overrides
- [basic-project](../basic-project/) — Minimal single-environment Flyway project

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`
