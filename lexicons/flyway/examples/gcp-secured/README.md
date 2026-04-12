# GCP Secured

Google Cloud Secret Manager integration for database credentials with Cloud SQL PostgreSQL instances using the GcpSecuredProject composite.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `chant init --lexicon flyway`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-flyway` | `@intentius/chant-lexicon-flyway` | Flyway project lifecycle: build, lint, configure, migrate, troubleshooting |

> **Using Claude Code?** Just ask:
>
> ```
> Build the gcp-secured Flyway project.
> ```

## What this produces

A `flyway.toml` configuration file with three environments (dev, staging, prod). Staging and prod use GCP Secret Manager via the `GcpResolver` for credential resolution with Cloud SQL socket factory connections. Dev uses local credentials with clean provisioner for offline development.

## Source files

| File | Description |
|------|-------------|
| `src/infra.ts` | Defines a GcpSecuredProject composite with GcpResolver, staging and prod environments with Secret Manager credentials, and a local dev environment with direct credentials |

## Prerequisites

- [Node.js](https://nodejs.org/) >= 22
- [Flyway CLI](https://documentation.red-gate.com/fd/command-line-184127404.html)

## Build

```bash
npm install && npm run build && npm run lint
```

## Related examples

- [azure-secured](../azure-secured/) — Azure Active Directory authentication for database credentials
- [vault-secured](../vault-secured/) — HashiCorp Vault integration for database credentials
- [multi-environment](../multi-environment/) — Four-environment setup with per-environment placeholders

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`
