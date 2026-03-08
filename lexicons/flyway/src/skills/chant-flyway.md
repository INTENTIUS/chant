---
skill: chant-flyway
description: Build, validate, and deploy Flyway database migrations from a chant project
user-invocable: true
---

# Flyway Migration Operational Playbook

## How chant and Flyway relate

chant is a **synthesis compiler** — it compiles TypeScript source files into `flyway.toml` (TOML config). `chant build` does not call Flyway or interact with databases; synthesis is pure and deterministic. Your job as an agent is to bridge synthesis and deployment:

- Use **chant** for: build, lint, diff (local TOML comparison)
- Use **flyway CLI** for: migrate, validate, info, clean, baseline, repair, diff, generate, undo

The source of truth for migration configuration is the TypeScript in `src/`. The generated `flyway.toml` is an intermediate artifact — never edit it by hand.

## Scaffolding a new project

### Initialize with a template

```bash
chant init --lexicon flyway                        # default: single environment
chant init --lexicon flyway --template multi-env    # dev/shadow/staging/prod
chant init --lexicon flyway --template vault-secured # Vault for credentials
chant init --lexicon flyway --template docker-dev   # Docker provisioner
```

### Available templates

| Template | What it generates | Best for |
|----------|-------------------|----------|
| *(default)* | FlywayProject + single dev Environment | Getting started |
| `multi-env` | 4 environments (dev/shadow/staging/prod) | Standard multi-env workflow |
| `vault-secured` | VaultResolver + secured environments | Enterprise credential management |
| `docker-dev` | Docker provisioner + clean shadow | Local development |

## Build and validate

### Build the config

```bash
chant build src/ --output flyway.toml
```

### Lint the source

```bash
chant lint src/
```

### What each step catches

| Step | Catches | When to run |
|------|---------|-------------|
| `chant lint` | Hardcoded credentials (WFW001), hardcoded URLs (WFW002), missing schemas (WFW003), invalid migration name (WFW004), duplicate version (WFW005) | Every edit |
| `chant build` | Post-synth: prod-clean-enabled (WFW101), missing validate-on-migrate (WFW102), prod-baseline (WFW103), unresolved refs (WFW104), empty locations (WFW105), invalid callback (WFW106), enterprise-only callback (WFW107), missing env URL (WFW108), provisioner missing filePath (WFW109), schema mismatch (WFW110) | Before deploy |
| `flyway validate` | Schema history mismatches, failed checksums | Before production migrate |

## Diff and preview

Before deploying, preview what will change at both the TOML and database levels.

### TOML-level diff (local, no database)

```bash
# Build current config
chant build src/ --output flyway.toml

# Compare against previous build (uses chant's built-in diff)
chant diff
```

### Database-level preview

```bash
# Show pending migrations and current state
flyway -environment=dev info

# Validate that pending migrations are well-formed
flyway -environment=dev validate

# For production — always validate before migrate
flyway -environment=prod validate
```

### Safe preview checklist

1. `chant build` — generates fresh `flyway.toml`
2. `chant diff` — review TOML changes since last build
3. `flyway info` — confirm which migrations are pending
4. `flyway validate` — ensure no checksum mismatches or conflicts
5. Review migration SQL files for correctness
6. Only then proceed to `flyway migrate`

## Running migrations

### Deployment strategies

| Strategy | Steps | When to use |
|----------|-------|-------------|
| **Safe path** (production) | build → lint → validate → info → migrate → verify | Any production deployment |
| **Fast path** (dev) | build → migrate | Local development iteration |
| **Desktop path** | edit schema model → diff → generate → apply → push | Redgate Desktop workflow |

### Safe path (production)

```bash
# 1. Build config
chant build src/ --output flyway.toml

# 2. Lint
chant lint src/

# 3. Validate against target environment
flyway -environment=prod validate

# 4. Preview pending migrations
flyway -environment=prod info

# 5. Apply migrations
flyway -environment=prod migrate

# 6. Verify
flyway -environment=prod info
```

### Fast path (dev)

```bash
chant build src/ --output flyway.toml
flyway -environment=dev migrate
```

### Environment management

```bash
# Dev environment
flyway -environment=dev migrate

# Staging (from CI)
flyway -environment=staging migrate

# Production (with validation)
flyway -environment=prod validate
flyway -environment=prod migrate
```

## Desktop workflow (Redgate Flyway Desktop)

The Desktop workflow uses a schema model as the source of truth, then auto-generates versioned migrations from diffs against a shadow database.

### Key concepts

- **Schema model** — a folder of SQL files representing the desired database state
- **Shadow database** — a disposable database rebuilt from migrations (`provisioner: "clean"`)
- **Development database** — the live dev database you modify directly
- `flyway diff` — compares development DB against the schema model
- `flyway generate` — creates a new versioned migration from the diff

### Typical Desktop flow

```bash
# 1. Make changes directly in your development database (via SQL editor, ORM, etc.)

# 2. Diff: compare development DB to schema model
flyway diff -diff.source=env:development -diff.target=schemaModel

# 3. Generate: create a versioned migration from the diff
flyway generate

# 4. Apply: run the new migration against shadow to verify
flyway -environment=shadow migrate

# 5. Verify: confirm schema model is in sync
flyway diff -diff.source=env:shadow -diff.target=schemaModel

# 6. Push migrations to version control
```

### DesktopProject composite

```typescript
import { DesktopProject } from "@intentius/chant-lexicon-flyway";

const result = DesktopProject({
  name: "my-app",
  databaseType: "postgresql",
  devUrl: "jdbc:postgresql://localhost:5432/devdb",
  shadowUrl: "jdbc:postgresql://localhost:5432/shadowdb",
  schemas: ["public"],
  schemaModelLocation: "./schema-model",
  undoScripts: true,
  environments: [
    { name: "staging", url: "jdbc:postgresql://staging:5432/db" },
    { name: "prod", url: "jdbc:postgresql://prod:5432/db" },
  ],
});
```

This generates: FlywayProject, FlywayConfig (with `schemaModelLocation`), FlywayDesktopConfig (`developmentEnvironment`, `shadowEnvironment`, undo settings), development Environment, shadow Environment (with `provisioner: "clean"`), and any downstream environments.

## Rollback and undo

### flyway undo (Enterprise tier)

```bash
# Undo the last applied versioned migration
flyway -environment=prod undo
```

Requires U-prefixed undo scripts (e.g., `U1__Undo_create_users.sql`) and an Enterprise license.

### flyway repair

```bash
# Fix checksum mismatches in schema history
flyway -environment=dev repair
```

Use `repair` when applied migrations have been edited and checksums no longer match. This updates the schema history — it does NOT change the database schema.

### Manual rollback pattern

When `undo` is unavailable (Community/Teams tier), write a compensating migration:

```sql
-- V3__Undo_add_column.sql
ALTER TABLE users DROP COLUMN IF EXISTS middle_name;
```

### When to use each approach

| Approach | Tier | What it does | When to use |
|----------|------|-------------|-------------|
| `flyway undo` | Enterprise | Runs U-script, removes last V from history | Clean rollback of recent migration |
| `flyway repair` | All | Updates checksums in history table | Checksum mismatch after harmless edit |
| Compensating V-migration | All | Forward-only fix via new migration | No undo scripts; production rollback |

## Resolvers and credentials

Flyway supports multiple resolver types for injecting secrets into `flyway.toml` without hardcoding them.

### Resolver types

| Syntax | Source | Best for |
|--------|--------|----------|
| `${env.VAR_NAME}` | Environment variable | CI/CD pipelines, local dev |
| `${vault.key}` | HashiCorp Vault | Enterprise secret management |
| `${localSecret.key}` | `flyway.user.toml` | Local developer secrets |
| `${googlesecrets.name}` | GCP Secret Manager | GCP-hosted environments |

### When to use which resolver

- **Local development**: `${localSecret.key}` with `flyway.user.toml`, or plain values in dev Environment
- **CI/CD**: `${env.VAR}` — inject from pipeline secrets
- **Production (Vault)**: `${vault.key}` with a VaultResolver
- **Production (GCP)**: `${googlesecrets.name}` with a GcpResolver

Additional resolver types supported: `${dapr.key}` (Dapr), `${clone.key}` (Clone), `${azuread.key}` (Azure AD), `${git.key}` (Git). These are less common — see Flyway documentation for details.

### Two-file pattern (flyway.user.toml)

Split configuration into two files:

- **`flyway.toml`** — committed to VCS. Contains project structure, environments, migration config. Uses `${localSecret.key}` for credentials.
- **`flyway.user.toml`** — gitignored. Contains actual secret values for the `localSecret` resolver.

```toml
# flyway.user.toml (gitignored)
[localSecret]
dev_password = "actual_password_here"
prod_password = "actual_prod_password"
```

In your chant source, reference these via the resolve intrinsic:

```typescript
import { resolve } from "@intentius/chant-lexicon-flyway/intrinsics";

export const dev = new Environment({
  url: "jdbc:postgresql://localhost:5432/devdb",
  user: "dev_user",
  password: resolve("localSecret", "dev_password"),
  schemas: ["public"],
  displayName: "dev",
});
```

## Composites

Composites are pre-built project patterns that generate multiple resources from a single configuration object. Use them to reduce boilerplate and enforce conventions.

### Available composites

| Composite | What it generates | Best for |
|-----------|-------------------|----------|
| `StandardProject` | project + dev (clean) + prod + config | Basic two-environment setup |
| `MultiEnvironmentProject` | project + N envs + optional shadow + config | Custom environment topologies |
| `DesktopProject` | project + config + desktop + dev + shadow + downstream envs | Redgate Desktop workflow |
| `VaultSecuredProject` | project + vault resolver + envs + config | HashiCorp Vault credentials |
| `GcpSecuredProject` | project + GCP resolver + envs + config | GCP Secret Manager credentials |
| `CiPipelineProject` | project + env with `${env.PREFIX_*}` refs + strict config | CI/CD pipeline environments |
| `DockerDevEnvironment` | single env with auto-built JDBC URL + docker provisioner | Docker-based local dev |
| `BlueprintMigrationSet` | migration file name metadata + callbacks | Planning migration sequences |

### environmentGroup helper

Use `environmentGroup()` to define shared config with per-environment overrides:

```typescript
import { environmentGroup } from "@intentius/chant-lexicon-flyway";

const envs = environmentGroup({
  schemas: ["public", "audit"],
  flyway: { validateMigrationNaming: true, outOfOrder: false },
  environments: {
    dev: {
      url: "jdbc:postgresql://localhost:5432/devdb",
      user: "dev_user",
      password: "dev_pass",
    },
    staging: {
      url: "jdbc:postgresql://staging:5432/db",
      user: "staging_user",
      flyway: { placeholders: { env: "staging" } },
    },
    prod: {
      url: "jdbc:postgresql://prod:5432/db",
      user: "prod_user",
      flyway: { placeholders: { env: "prod" }, cleanDisabled: true },
    },
  },
});
```

**Merge semantics**: scalars — child wins; objects (e.g., `placeholders`) — deep merge (child keys override, parent keys preserved); arrays (e.g., `locations`) — child replaces parent entirely.

## CI/CD integration

### General pattern

```bash
# In your CI pipeline:
# 1. Build config (chant runs in CI, no database needed)
chant build src/ --output flyway.toml

# 2. Lint (optional but recommended)
chant lint src/

# 3. Run migrations against target environment
flyway -environment=ci migrate
```

### CiPipelineProject composite

```typescript
import { CiPipelineProject } from "@intentius/chant-lexicon-flyway";

const result = CiPipelineProject({
  name: "my-app",
  databaseType: "postgresql",
  envVarPrefix: "FLYWAY",
  environmentName: "ci",
});
```

This generates an environment with `${env.FLYWAY_URL}`, `${env.FLYWAY_USER}`, `${env.FLYWAY_PASSWORD}` references and a strict config (`validateMigrationNaming`, `validateOnMigrate`, `cleanDisabled: true`).

### Environment variable injection

Set these in your CI provider's secret management:

```bash
FLYWAY_URL=jdbc:postgresql://prod-host:5432/proddb
FLYWAY_USER=flyway_ci
FLYWAY_PASSWORD=<from-secret-store>
```

## Migration file naming

| Prefix | Pattern | Example | Description |
|--------|---------|---------|-------------|
| V | V{version}__{description}.sql | V1__Create_users.sql | Versioned migration |
| R | R__{description}.sql | R__Refresh_views.sql | Repeatable migration |
| U | U{version}__{description}.sql | U1__Undo_create_users.sql | Undo migration (Enterprise) |

## Troubleshooting

| Problem | Diagnostic | Fix |
|---------|-----------|-----|
| "Validate failed" | `flyway info` — check for PENDING/FAILED | Fix migration SQL, then `flyway repair` |
| "Checksum mismatch" | Applied migration was modified | `flyway repair` to update checksums |
| "Out of order" | Migration version lower than applied | Set `outOfOrder = true` or fix version |
| "Schema not found" | Target schema doesn't exist | Create schema or fix `schemas` array |
| "Connection refused" | Database unreachable | Check `url`, network, database status |
| "Authentication failed" | Bad credentials | Check `user`/`password`, resolver config |
| Provisioner failure (clean) | `cleanDisabled = true` on shadow env | Set `cleanDisabled = false` or remove from shadow |
| Provisioner failure (docker) | Docker not running or image pull failed | Check `docker ps`, verify `dockerImage` value |
| Callback error | Callback script has SQL error | Check callback SQL in `sql/callbacks/`, fix syntax |
| "undo is not supported" | Using `flyway undo` without Enterprise license | Upgrade to Enterprise or use compensating V-migration |
| TOML parse error | Malformed `flyway.toml` output | Run `chant build` and check for TypeScript errors in `src/` |
| Encoding mismatch | Migration file encoding differs from config | Set `encoding` in FlywayConfig to match files (UTF-8 recommended) |
| Placeholder not resolved | `${placeholder}` in SQL not matched | Check `placeholders` map in environment or config |
| Schema model out of sync | Desktop `diff` shows unexpected changes | Run `flyway diff` and `flyway generate` to reconcile |

## Quick reference

```bash
# Build
chant build src/ --output flyway.toml

# Lint
chant lint src/

# Diff (TOML-level)
chant diff

# Info
flyway -environment=dev info

# Migrate
flyway -environment=dev migrate

# Validate
flyway -environment=dev validate

# Repair
flyway -environment=dev repair

# Baseline
flyway -environment=dev baseline

# Clean (dev only!)
flyway -environment=dev clean

# Undo (Enterprise)
flyway -environment=dev undo

# Desktop: diff
flyway diff -diff.source=env:development -diff.target=schemaModel

# Desktop: generate migration
flyway generate
```
