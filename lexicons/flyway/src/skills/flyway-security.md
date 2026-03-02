---
skill: flyway-security
description: Flyway credential management, vault integration, clean protection, and security best practices
user-invocable: true
---

# Flyway Security Patterns

## Credential Management

### Never Hardcode Credentials

chant's lint rule WFW001 flags hardcoded credentials in source. Always use resolvers:

```typescript
// Bad -- flagged by WFW001
export const prod = new Environment({
  url: "jdbc:postgresql://prod:5432/db",
  user: "admin",
  password: "SuperSecret123",  // hardcoded credential
});
```

### Environment Variable Resolver

The simplest approach for CI/CD pipelines:

```typescript
import { Environment } from "@intentius/chant-lexicon-flyway";

export const prod = new Environment({
  url: "${env.DB_URL}",
  user: "${env.DB_USER}",
  password: "${env.DB_PASSWORD}",
  schemas: ["public"],
  displayName: "prod",
});
```

Set these in your CI provider's secret management (GitHub Actions secrets, GitLab CI variables, etc.).

### Local Secret Resolver

For local development, use `flyway.user.toml` (gitignored):

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

Create `flyway.user.toml` (add to `.gitignore`):

```toml
[localSecret]
dev_password = "actual_password_here"
```

## Vault Integration

### HashiCorp Vault

Use `VaultResolver` for enterprise-grade secret management:

```typescript
import { VaultResolver, Environment } from "@intentius/chant-lexicon-flyway";
import { resolve } from "@intentius/chant-lexicon-flyway/intrinsics";

export const vault = new VaultResolver({
  url: "https://vault.example.com",
  token: "${env.VAULT_TOKEN}",
  engineName: "secret",
  engineVersion: "v2",
});

export const prod = new Environment({
  url: resolve("vault", "prod-db-url"),
  user: resolve("vault", "prod-db-user"),
  password: resolve("vault", "prod-db-password"),
  schemas: ["public"],
  displayName: "prod",
});
```

### VaultSecuredProject Composite

Generates project, vault resolver, environments, and config in one call:

```typescript
import { VaultSecuredProject } from "@intentius/chant-lexicon-flyway";

const result = VaultSecuredProject({
  name: "my-app",
  databaseType: "postgresql",
  vaultUrl: "https://vault.example.com",
  vaultToken: "${env.VAULT_TOKEN}",
  environments: [
    { name: "dev", url: "jdbc:postgresql://localhost:5432/devdb" },
    {
      name: "prod",
      url: "jdbc:postgresql://prod:5432/db",
      userKey: "prod-db-user",
      passwordKey: "prod-db-password",
    },
  ],
});
```

### GCP Secret Manager

```typescript
import { GcpResolver, Environment } from "@intentius/chant-lexicon-flyway";
import { resolve } from "@intentius/chant-lexicon-flyway/intrinsics";

export const gcp = new GcpResolver({
  project: "my-project",
});

export const prod = new Environment({
  url: resolve("googlesecrets", "db-url"),
  user: resolve("googlesecrets", "db-user"),
  password: resolve("googlesecrets", "db-password"),
  schemas: ["public"],
  displayName: "prod",
});
```

## Clean Protection

### Disable Clean in Production

Post-synth check WFW101 flags production environments with `cleanDisabled = false`:

```typescript
import { FlywayConfig } from "@intentius/chant-lexicon-flyway";

export const config = new FlywayConfig({
  locations: ["filesystem:sql/migrations"],
  cleanDisabled: true,  // prevents accidental data loss
});
```

### Per-Environment Clean Control

Only enable clean on shadow/dev environments:

```typescript
import { Environment } from "@intentius/chant-lexicon-flyway";

export const shadow = new Environment({
  url: "jdbc:postgresql://localhost:5432/shadowdb",
  user: "dev_user",
  password: "dev_pass",
  schemas: ["public"],
  displayName: "shadow",
  provisioner: "clean",  // clean is expected here
});

// Production: no provisioner, cleanDisabled via config
export const prod = new Environment({
  url: "${env.PROD_DB_URL}",
  user: "${env.PROD_DB_USER}",
  password: "${env.PROD_DB_PASSWORD}",
  schemas: ["public"],
  displayName: "prod",
});
```

## URL Security

### Never Hardcode URLs

Lint rule WFW002 flags hardcoded database URLs. Use variables or resolvers for non-local environments:

```typescript
// Good: env var for non-local
export const staging = new Environment({
  url: "${env.STAGING_DB_URL}",
  user: "${env.STAGING_DB_USER}",
  password: "${env.STAGING_DB_PASSWORD}",
  schemas: ["public"],
  displayName: "staging",
});

// OK: localhost for dev is acceptable
export const dev = new Environment({
  url: "jdbc:postgresql://localhost:5432/devdb",
  user: "dev_user",
  password: resolve("localSecret", "dev_password"),
  schemas: ["public"],
  displayName: "dev",
});
```

## Validate on Migrate

### Always Validate Before Migrating Production

Post-synth check WFW102 warns when `validateOnMigrate` is not enabled:

```typescript
import { FlywayConfig } from "@intentius/chant-lexicon-flyway";

export const config = new FlywayConfig({
  locations: ["filesystem:sql/migrations"],
  validateOnMigrate: true,
  validateMigrationNaming: true,
  cleanDisabled: true,
});
```

## Two-File Pattern

Split configuration for team safety:

| File | Committed | Contains |
|------|-----------|----------|
| `flyway.toml` | Yes | Structure, environments, migration config, resolver references |
| `flyway.user.toml` | No (.gitignored) | Actual secret values for `localSecret` resolver |

```toml
# flyway.user.toml (gitignored)
[localSecret]
dev_password = "actual_dev_password"
staging_password = "actual_staging_password"
```

## Security Checklist

| Item | Check | chant Rule |
|------|-------|-----------|
| No hardcoded passwords | Use resolvers | WFW001 |
| No hardcoded URLs (non-local) | Use env vars or resolvers | WFW002 |
| Clean disabled in production | `cleanDisabled: true` | WFW101 |
| Validate on migrate | `validateOnMigrate: true` | WFW102 |
| No baseline in production | Avoid baseline on prod | WFW103 |
| Schema history table named | `table: "flyway_schema_history"` | -- |
| `flyway.user.toml` gitignored | Add to `.gitignore` | -- |
| Vault token from env | `${env.VAULT_TOKEN}` | -- |
