// Docker-based local development: Docker provisioner for automatic container
// management, clean shadow database, repeatable migrations for views/functions.
// Demonstrates the DockerDevEnvironment composite.

import {
  DockerDevEnvironment,
  FlywayProject,
  FlywayConfig,
  Environment,
  BlueprintMigrationSet,
} from "@intentius/chant-lexicon-flyway";

export const project = new FlywayProject({
  name: "inventory-app",
});

export const config = new FlywayConfig({
  defaultSchema: "public",
  locations: ["filesystem:sql/versioned", "filesystem:sql/repeatable"],
  databaseType: "postgresql",
  validateMigrationNaming: true,
  mixed: true,
});

// Docker-provisioned dev environment
const dockerDev = DockerDevEnvironment({
  databaseType: "postgresql",
  port: 5433,
  dbName: "inventory_dev",
  name: "dev",
  dockerImage: "postgres:16-alpine",
  schemas: ["public", "inventory"],
});

export const devEnv = dockerDev.environment;

// Shadow database for Flyway Desktop diff workflows, also Docker-provisioned
const dockerShadow = DockerDevEnvironment({
  databaseType: "postgresql",
  port: 5434,
  dbName: "inventory_shadow",
  name: "shadow",
  dockerImage: "postgres:16-alpine",
  schemas: ["public", "inventory"],
  defaults: {
    environment: { provisioner: "clean" },
  },
});

export const shadowEnv = dockerShadow.environment;

// Blueprint for the migration file layout including repeatable migrations
export const { migrations, callbacks } = BlueprintMigrationSet({
  versions: [
    { version: "1", description: "Create products table" },
    { version: "2", description: "Create warehouses table" },
    { version: "3", description: "Add stock levels table" },
    { version: "4", description: "Add product categories" },
    { type: "R", version: "", description: "Create inventory summary view" },
    { type: "R", version: "", description: "Create low stock alert function" },
  ],
});
