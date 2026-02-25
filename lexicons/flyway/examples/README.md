# Flyway Lexicon Examples

Reference projects demonstrating common Flyway configuration patterns with chant.

## Examples

| Example | What it demonstrates |
|---------|---------------------|
| `basic-project` | Single PostgreSQL database, dev-only environment |
| `multi-environment` | Dev/shadow/staging/prod with `MultiEnvironmentProject` composite |
| `vault-secured` | HashiCorp Vault credentials with `VaultSecuredProject` composite |
| `gcp-secured` | GCP Secret Manager credentials with `GcpSecuredProject` composite |
| `ci-pipeline` | CI/CD environment variables with `CiPipelineProject` composite |
| `docker-dev` | Docker provisioner with `DockerDevEnvironment` composite |
| `desktop-project` | Redgate Flyway Desktop workflow with `DesktopProject` composite |
| `environment-overrides` | Shared config with per-environment overrides via `environmentGroup` |
| `multi-schema` | Multiple schemas with cross-schema placeholder references |
| `callbacks` | Lifecycle callbacks with `BlueprintMigrationSet` |
| `migration-lifecycle` | Full runnable lifecycle: Docker, SQL migrations (V1→V3), environmentGroup inheritance |

## Using the skill

These examples are designed to be used with the **chant-flyway** skill. When the skill is active, ask the agent to:

- "Create a Flyway config for PostgreSQL" (see `basic-project`)
- "Set up a Flyway Desktop project with schema model" (see `desktop-project`)
- "Add a Vault-secured production environment" (see `vault-secured`)
- "Set up CI/CD for Flyway migrations" (see `ci-pipeline`)
- "Add per-environment overrides with shared config" (see `environment-overrides`)

The skill provides the full operational playbook: scaffolding, build/lint, deployment strategies, rollback, resolvers, composites, and troubleshooting.

## Running tests

```bash
bun test lexicons/flyway/examples/
```

This builds each example through the serializer and verifies the output contains expected TOML structure.

## Project structure

Each example follows the standard chant project layout:

```
<example>/
  package.json      # workspace deps: @intentius/chant-lexicon-flyway
  src/
    infra.ts        # resource definitions
```

All resources use `new` constructors (e.g., `new FlywayProject({...})`), and composites are plain functions that return prop objects to be wrapped with constructors.
