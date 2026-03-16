# Multi-Environment

Four-environment setup (dev, shadow, staging, prod) with shadow database for diff workflows and per-environment placeholder customization using MultiEnvironmentProject.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `chant init --lexicon flyway`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-flyway` | `@intentius/chant-lexicon-flyway` | Flyway project lifecycle: build, lint, configure, migrate, troubleshooting |

> **Using Claude Code?** Just ask:
>
> ```
> Build the multi-environment Flyway project.
> ```

## What this produces

A `flyway.toml` configuration file with four environments (dev, shadow, staging, prod) and per-environment Placeholder resources for app base URLs and log levels. Dev uses a clean provisioner, prod has clean disabled, and the shadow database supports Flyway Desktop diff workflows.

## Source files

| File | Description |
|------|-------------|
| `src/infra.ts` | Defines a MultiEnvironmentProject composite with four environments, shadow database support, and per-environment Placeholder resources for app URLs and log levels |

## Prerequisites

- [Bun](https://bun.sh) or [Node.js](https://nodejs.org/) >= 22
- [Flyway CLI](https://documentation.red-gate.com/fd/command-line-184127404.html)

## Build

```bash
bun install && bun run build && bun run lint
```

## Related examples

- [environment-overrides](../environment-overrides/) — Per-environment config overrides with environmentGroup deep-merge
- [multi-schema](../multi-schema/) — Multiple database schemas with cross-schema placeholder references
- [desktop-project](../desktop-project/) — Flyway Desktop pattern with shadow database and Redgate Compare

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`
