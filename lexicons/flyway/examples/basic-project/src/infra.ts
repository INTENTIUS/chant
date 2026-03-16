// Basic Flyway project: single PostgreSQL database, dev-only environment,
// three versioned migrations. Demonstrates FlywayProject, FlywayConfig,
// and Environment primitives.

import {
  FlywayProject,
  FlywayConfig,
  Environment,
} from "@intentius/chant-lexicon-flyway";

export const project = new FlywayProject({
  name: "basic-app",
});

export const config = new FlywayConfig({
  defaultSchema: "public",
  locations: ["filesystem:sql"],
  databaseType: "postgresql",
  validateMigrationNaming: true,
  baselineOnMigrate: false,
});

export const dev = new Environment({
  displayName: "dev",
  url: "jdbc:postgresql://localhost:5432/basic_app_dev",
  schemas: ["public"],
  provisioner: "clean",
});
