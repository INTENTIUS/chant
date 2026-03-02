# Environment Overrides

Per-environment Flyway configuration overrides using the environmentGroup composite, with shared base settings deep-merged with environment-specific differences.

## Prerequisites

- [Bun](https://bun.sh)
- [Flyway CLI](https://documentation.red-gate.com/fd/command-line-184127404.html)

## Quick start

```bash
bun install
bun run build    # generates flyway.toml from src/infra.ts
bun run lint     # lint the chant source
```

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`
