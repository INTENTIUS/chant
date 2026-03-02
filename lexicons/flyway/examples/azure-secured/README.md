# Azure Secured

Azure Active Directory authentication for Azure SQL and PostgreSQL databases using managed identity and service principal credentials.

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
