# Desktop Project

Redgate Flyway Desktop pattern with development and shadow databases, Redgate Compare configuration, and undo script support for desktop schema comparison workflows.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `chant init --lexicon flyway`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-flyway` | `@intentius/chant-lexicon-flyway` | Flyway project lifecycle: build, lint, configure, migrate, troubleshooting |

> **Using Claude Code?** Just ask:
>
> ```
> Build the desktop-project Flyway project.
> ```

## What this produces

A `flyway.toml` configuration file with development, shadow, test, and prod environments, plus `[flywayDesktop]` and `[redgateCompare]` sections for Redgate Flyway Desktop integration. Includes schema-model location, filter file, and undo script support.

## Source files

| File | Description |
|------|-------------|
| `src/infra.ts` | Defines a DesktopProject composite with dev/shadow databases, FlywayDesktopConfig, RedgateCompareConfig, and additional test/prod environments |

## Prerequisites

- [Node.js](https://nodejs.org/) >= 22
- [Flyway CLI](https://documentation.red-gate.com/fd/command-line-184127404.html)

## Build

```bash
npm install && npm run build && npm run lint
```

## Related examples

- [docker-dev](../docker-dev/) — Docker-based local development with shadow database
- [multi-environment](../multi-environment/) — Four-environment setup with shadow database for diff workflows
- [basic-project](../basic-project/) — Minimal single-environment Flyway project

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`
