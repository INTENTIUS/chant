// Multi-environment Flyway project: four environments (dev, shadow, staging, prod),
// shadow database with clean provisioner, per-environment placeholder overrides.
// Demonstrates the MultiEnvironmentProject composite.

import {
  MultiEnvironmentProject,
  FlywayProject,
  FlywayConfig,
  Environment,
  Placeholder,
} from "@intentius/chant-lexicon-flyway";

const result = MultiEnvironmentProject({
  name: "order-service",
  databaseType: "postgresql",
  schemas: ["public", "orders"],
  locations: ["filesystem:sql/versioned", "filesystem:sql/repeatable"],
  environments: [
    { name: "dev", url: "jdbc:postgresql://localhost:5432/orders_dev", provisioner: "clean" },
    { name: "staging", url: "jdbc:postgresql://staging-db.internal:5432/orders" },
    { name: "prod", url: "jdbc:postgresql://prod-db.internal:5432/orders" },
  ],
  includeShadow: true,
  shadowUrl: "jdbc:postgresql://localhost:5432/orders_shadow",
});

export const project = new FlywayProject(result.project);

export const config = new FlywayConfig(result.config);

export const devEnv = new Environment(result.environments.dev);

export const stagingEnv = new Environment(result.environments.staging);

export const prodEnv = new Environment(result.environments.prod);

export const shadowEnv = new Environment(result.shadow!);

// Per-environment placeholders for tenant-specific configuration
export const devAppUrl = new Placeholder({ key: "app_base_url", value: "http://localhost:3000" });
export const stagingAppUrl = new Placeholder({ key: "app_base_url", value: "https://staging.orders.example.com" });
export const prodAppUrl = new Placeholder({ key: "app_base_url", value: "https://orders.example.com" });
export const devLogLevel = new Placeholder({ key: "log_level", value: "DEBUG" });
export const prodLogLevel = new Placeholder({ key: "log_level", value: "WARN" });
