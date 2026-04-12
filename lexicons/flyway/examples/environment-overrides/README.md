# Environment Overrides

Per-environment Flyway configuration overrides using the environmentGroup composite, with shared base settings deep-merged with environment-specific differences.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `chant init --lexicon flyway`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-flyway` | `@intentius/chant-lexicon-flyway` | Flyway project lifecycle: build, lint, configure, migrate, troubleshooting |

> **Using Claude Code?** Just ask:
>
> ```
> Build the environment-overrides Flyway project.
> ```

## What this produces

A `flyway.toml` configuration file with three environments (dev, staging, prod) generated from an `environmentGroup`. Shared settings like `cleanDisabled`, `placeholders`, and `locations` are deep-merged with per-environment overrides — dev gets debug logging and clean enabled, prod gets strict validation and warn-level logging.

## Source files

| File | Description |
|------|-------------|
| `src/infra.ts` | Defines FlywayProject, FlywayConfig, and an environmentGroup with shared flyway settings deep-merged into dev, staging, and prod environments |

## Prerequisites

- [Node.js](https://nodejs.org/) >= 22
- [Flyway CLI](https://documentation.red-gate.com/fd/command-line-184127404.html)

## Build

```bash
npm install && npm run build && npm run lint
```

## Related examples

- [migration-lifecycle](../migration-lifecycle/) — Full walkthrough of environmentGroup inheritance with Docker databases
- [multi-environment](../multi-environment/) — Four-environment setup using the MultiEnvironmentProject composite
- [ci-pipeline](../ci-pipeline/) — CI/CD integration with environment-variable credentials

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`
