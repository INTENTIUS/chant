---
skill: flyway-migrations
description: Flyway migration naming, versioned vs repeatable, callbacks, and multi-environment patterns
user-invocable: true
---

# Flyway Migration Patterns

## Migration Naming Conventions

### Versioned Migrations

Versioned migrations run exactly once in order. Use the `V` prefix:

```
V1__Create_users_table.sql
V2__Add_email_column.sql
V3__Create_orders_table.sql
V1.1__Add_index_on_email.sql
```

Rules:
- Version must be unique across all migrations
- Double underscore `__` separates version from description
- Use underscores in descriptions (not spaces)
- Versions are compared as dot-separated integers: `1.1` < `2` < `10`

### Repeatable Migrations

Repeatable migrations run every time their checksum changes. Use the `R` prefix:

```
R__Create_views.sql
R__Refresh_materialized_views.sql
R__Update_stored_procedures.sql
```

Repeatable migrations always run after all pending versioned migrations. They are ideal for views, stored procedures, and other idempotent objects.

### Undo Migrations (Enterprise)

Undo migrations reverse a versioned migration. Use the `U` prefix:

```
U1__Undo_create_users_table.sql
U2__Undo_add_email_column.sql
```

### Chant Validation

chant's lint rule WFW004 validates migration naming. The post-synth check WFW105 catches empty migration locations.

## Versioned vs Repeatable

| Aspect | Versioned (`V`) | Repeatable (`R`) |
|--------|----------------|-----------------|
| Runs | Once | Every time checksum changes |
| Ordering | By version number | After all versioned, alphabetically |
| Use for | Schema DDL, data migrations | Views, procedures, grants |
| Rollback | `U` script or compensating migration | Edit and re-run |

### When to Use Each

```typescript
import { FlywayConfig } from "@intentius/chant-lexicon-flyway";

export const config = new FlywayConfig({
  locations: [
    "filesystem:sql/migrations",     // V*.sql versioned migrations
    "filesystem:sql/repeatable",      // R*.sql repeatable migrations
  ],
  validateMigrationNaming: true,
});
```

## Callbacks

Flyway callbacks execute SQL or scripts at specific lifecycle points:

| Callback | When it fires | Common use |
|----------|-------------|-----------|
| `beforeMigrate` | Before migration starts | Lock checks, pre-flight validation |
| `afterMigrate` | After all migrations complete | Grant permissions, refresh views |
| `beforeEachMigrate` | Before each migration | Logging, notifications |
| `afterEachMigrate` | After each migration | Logging, verification |
| `beforeClean` | Before clean operation | Backup, safety check |
| `afterClean` | After clean completes | Seed data |
| `beforeValidate` | Before validate | Custom validation |
| `afterValidate` | After validate | Report generation |

### Callback File Layout

Place callback SQL files in the migration location:

```
sql/
  callbacks/
    beforeMigrate.sql           # runs before each migrate
    afterMigrate.sql            # runs after all migrations
    beforeMigrate__audit.sql    # named callback (multiple per event)
  migrations/
    V1__Create_users.sql
    V2__Add_email.sql
```

### Configuring Callbacks in Chant

```typescript
import { FlywayConfig } from "@intentius/chant-lexicon-flyway";

export const config = new FlywayConfig({
  locations: ["filesystem:sql/migrations"],
  callbacks: ["filesystem:sql/callbacks"],
  validateMigrationNaming: true,
});
```

Post-synth check WFW106 validates callback names. WFW107 flags enterprise-only callbacks.

## Multi-Environment Patterns

### Environment Group

Use `environmentGroup` to share config across environments with per-env overrides:

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

### Shadow Database Pattern

A shadow database is rebuilt from scratch on every `migrate` using `provisioner: "clean"`. It validates that migrations produce the expected schema:

```typescript
import { Environment } from "@intentius/chant-lexicon-flyway";

export const shadow = new Environment({
  url: "jdbc:postgresql://localhost:5432/shadowdb",
  user: "dev_user",
  password: "dev_pass",
  schemas: ["public"],
  displayName: "shadow",
  provisioner: "clean",
});
```

### CI/CD Pipeline Pattern

```typescript
import { CiPipelineProject } from "@intentius/chant-lexicon-flyway";

const result = CiPipelineProject({
  name: "my-app",
  databaseType: "postgresql",
  envVarPrefix: "FLYWAY",
  environmentName: "ci",
});
```

This generates environment references like `${env.FLYWAY_URL}`, `${env.FLYWAY_USER}`, `${env.FLYWAY_PASSWORD}` that map to CI pipeline secrets.

## Migration Best Practices

### Idempotent DDL

Write migrations that can safely re-run (useful for repair scenarios):

```sql
-- V1__Create_users.sql
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    created_at TIMESTAMP DEFAULT NOW()
);
```

### Data Migrations

Separate schema changes from data migrations. Use transactions:

```sql
-- V3__Backfill_display_name.sql
BEGIN;
UPDATE users SET display_name = email WHERE display_name IS NULL;
COMMIT;
```

### Large Table Migrations

For large tables, use batched updates to avoid long locks:

```sql
-- V5__Add_index_concurrently.sql
-- Flyway: PostgreSQL concurrent index (no transaction)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_email ON users(email);
```

Set `executeInTransaction = false` for DDL that cannot run inside a transaction.
