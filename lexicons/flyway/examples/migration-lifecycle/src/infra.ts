// Full migration lifecycle: Docker databases, SQL migrations (V1→V3),
// and environmentGroup inheritance with deep-merge semantics.
//
// Deep-merge rules for environmentGroup:
//   - Scalars (string, number, boolean) → per-env value replaces shared value
//   - Objects (placeholders, flyway nested) → keys are merged (shared + override)
//   - Arrays (schemas, locations) → per-env array replaces shared array entirely

import {
  environmentGroup,
  FlywayProject,
  FlywayConfig,
  Environment,
} from "@intentius/chant-lexicon-flyway";

export const project = new FlywayProject({ name: "lifecycle" });

export const config = new FlywayConfig({
  databaseType: "postgresql",
  locations: ["filesystem:sql/migrations"],
  defaultSchema: "public",
  validateMigrationNaming: true,
});

// environmentGroup defines shared config that all environments inherit,
// then each environment can override individual keys.
//
// Inheritance diagram:
//
//   shared
//   ├── cleanDisabled: true
//   ├── outOfOrder: false
//   ├── placeholders: { appName, logLevel: "info", auditEnabled: "true" }
//   │
//   ├─► dev        → cleanDisabled: false, logLevel: "debug"
//   ├─► shadow     → provisioner: "clean" (everything else inherited)
//   └─► prod       → validateOnMigrate: true, logLevel: "warn", env-var creds

const envs = environmentGroup({
  schemas: ["public"],
  flyway: {
    locations: ["filesystem:sql/migrations"],
    cleanDisabled: true,
    outOfOrder: false,
    placeholders: {
      appName: "lifecycle",
      logLevel: "info",
      auditEnabled: "true",
    },
  },
  environments: {
    dev: {
      url: "jdbc:postgresql://localhost:5432/lifecycle_dev",
      user: "postgres",
      password: "postgres",
      flyway: {
        // Override: allow clean in dev for fast iteration
        cleanDisabled: false,
        // Merged into shared placeholders — appName and auditEnabled still inherited
        placeholders: { logLevel: "debug" },
      },
    },
    shadow: {
      url: "jdbc:postgresql://localhost:5433/lifecycle_shadow",
      user: "postgres",
      password: "postgres",
      // Shadow inherits all shared flyway config, adds provisioner for
      // automatic clean-before-migrate behavior
      provisioner: "clean",
    },
    prod: {
      url: "jdbc:postgresql://prod-db.internal:5432/lifecycle",
      user: "${env.PROD_DB_USER}",
      password: "${env.PROD_DB_PASSWORD}",
      flyway: {
        validateOnMigrate: true,
        placeholders: { logLevel: "warn" },
      },
    },
  },
});

export const devEnv = new Environment(envs.dev);
export const shadowEnv = new Environment(envs.shadow);
export const prodEnv = new Environment(envs.prod);
