// Flyway Desktop project: development + shadow environments with [flywayDesktop]
// and [redgateCompare] sections. Mirrors the canonical Redgate `fw_auto_pilot` pattern.
// Demonstrates the DesktopProject composite.

import {
  DesktopProject,
  FlywayProject,
  FlywayConfig,
  Environment,
  FlywayDesktopConfig,
  RedgateCompareConfig,
} from "@intentius/chant-lexicon-flyway";

const result = DesktopProject({
  name: "inventory-service",
  databaseType: "postgresql",
  devUrl: "jdbc:postgresql://localhost:5432/inventory_dev",
  shadowUrl: "jdbc:postgresql://localhost:5432/inventory_shadow",
  schemas: ["public", "inventory"],
  environments: [
    { name: "test", url: "jdbc:postgresql://test-db.internal:5432/inventory" },
    { name: "prod", url: "jdbc:postgresql://prod-db.internal:5432/inventory" },
  ],
  filterFile: "./Filter.scpf",
  schemaModelLocation: "./schema-model",
  undoScripts: true,
});

export const project = new FlywayProject(result.project);

export const config = new FlywayConfig(result.config);

export const desktop = new FlywayDesktopConfig(result.desktop);

export const compare = new RedgateCompareConfig(result.compare!);

export const development = new Environment(result.development);

export const shadow = new Environment(result.shadow);

export const testEnv = new Environment(result.environments.test);

export const prodEnv = new Environment(result.environments.prod);
