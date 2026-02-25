// Per-environment flyway overrides with shared config deep-merged.
// Demonstrates the environmentGroup composite — shared placeholders,
// locations, and settings with per-environment diffs only.

import {
  environmentGroup,
  FlywayProject,
  FlywayConfig,
  Environment,
} from "@intentius/chant-lexicon-flyway";

export const project = new FlywayProject({ name: "payments" });

export const config = new FlywayConfig({
  databaseType: "postgresql",
  locations: ["filesystem:migrations"],
  defaultSchema: "public",
  validateMigrationNaming: true,
});

const envs = environmentGroup({
  schemas: ["public"],
  flyway: {
    locations: ["filesystem:migrations"],
    cleanDisabled: true,
    placeholders: { appName: "payments", logLevel: "info", region: "us-east-1" },
  },
  environments: {
    dev: {
      url: "jdbc:postgresql://localhost:5432/payments_dev",
      flyway: {
        cleanDisabled: false,
        placeholders: { logLevel: "debug" },
      },
    },
    staging: {
      url: "jdbc:postgresql://staging-db.internal:5432/payments",
      // Inherits all shared flyway config as-is
    },
    prod: {
      url: "jdbc:postgresql://prod-db.internal:5432/payments",
      user: "${env.PROD_DB_USER}",
      password: "${env.PROD_DB_PASSWORD}",
      flyway: {
        validateOnMigrate: true,
        placeholders: { logLevel: "warn", region: "us-east-1" },
      },
    },
  },
});

export const devEnv = new Environment(envs.dev);
export const stagingEnv = new Environment(envs.staging);
export const prodEnv = new Environment(envs.prod);
