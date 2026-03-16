# Azure Secured

Azure Active Directory authentication for Azure SQL and PostgreSQL databases using managed identity and service principal credentials.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `chant init --lexicon flyway`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-flyway` | `@intentius/chant-lexicon-flyway` | Flyway project lifecycle: build, lint, configure, migrate, troubleshooting |

> **Using Claude Code?** Just ask:
>
> ```
> Build the azure-secured Flyway project.
> ```

## What this produces

A `flyway.toml` configuration file with three environments (dev, staging, prod). Dev uses local SQL Server credentials, while staging and prod authenticate via Azure Active Directory using the `AzureAdResolver` for managed identity or service principal token acquisition.

## Source files

| File | Description |
|------|-------------|
| `src/infra.ts` | Defines FlywayProject, FlywayConfig, AzureAdResolver, and three environments (dev with local creds, staging and prod with Azure AD authentication) |

## Prerequisites

- [Bun](https://bun.sh) or [Node.js](https://nodejs.org/) >= 22
- [Flyway CLI](https://documentation.red-gate.com/fd/command-line-184127404.html)

## Build

```bash
bun install && bun run build && bun run lint
```

## Related examples

- [vault-secured](../vault-secured/) — HashiCorp Vault integration for database credentials
- [gcp-secured](../gcp-secured/) — Google Cloud Secret Manager for database credentials
- [multi-environment](../multi-environment/) — Four-environment setup with per-environment placeholders

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`
