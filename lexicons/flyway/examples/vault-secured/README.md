# Vault Secured

HashiCorp Vault integration for production and staging database credentials with local secret fallback for offline development using VaultSecuredProject and LocalSecretResolver.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `chant init --lexicon flyway`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-flyway` | `@intentius/chant-lexicon-flyway` | Flyway project lifecycle: build, lint, configure, migrate, troubleshooting |

> **Using Claude Code?** Just ask:
>
> ```
> Build the vault-secured Flyway project.
> ```

## What this produces

A `flyway.toml` configuration file with three environments (dev, staging, prod). Staging and prod resolve credentials from HashiCorp Vault via the `VaultResolver`, while dev uses a `LocalSecretResolver` with the `resolve` intrinsic for offline development without Vault access.

## Source files

| File | Description |
|------|-------------|
| `src/infra.ts` | Defines a VaultSecuredProject composite with VaultResolver for staging/prod credentials, a LocalSecretResolver for dev, and the resolve intrinsic for credential references |

## Prerequisites

- [Bun](https://bun.sh) or [Node.js](https://nodejs.org/) >= 22
- [Flyway CLI](https://documentation.red-gate.com/fd/command-line-184127404.html)

## Build

```bash
bun install && bun run build && bun run lint
```

## Related examples

- [azure-secured](../azure-secured/) — Azure Active Directory authentication for database credentials
- [gcp-secured](../gcp-secured/) — Google Cloud Secret Manager for database credentials
- [ci-pipeline](../ci-pipeline/) — CI/CD integration with environment-variable credentials

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`
