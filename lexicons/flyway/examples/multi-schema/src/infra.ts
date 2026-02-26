// Multi-schema project: manages public, audit, and reporting schemas with
// schema-specific placeholders for cross-schema references in migrations.
// Demonstrates FlywayProject, FlywayConfig, Environment with multiple schemas.

import {
  FlywayProject,
  FlywayConfig,
  Environment,
  Placeholder,
} from "@intentius/chant-lexicon-flyway";

export const project = new FlywayProject({
  name: "analytics-platform",
});

export const config = new FlywayConfig({
  defaultSchema: "public",
  locations: [
    "filesystem:sql/public",
    "filesystem:sql/audit",
    "filesystem:sql/reporting",
  ],
  databaseType: "postgresql",
  validateMigrationNaming: true,
  mixed: false,
});

// Dev environment manages all three schemas
export const devEnv = new Environment({
  displayName: "dev",
  url: "jdbc:postgresql://localhost:5432/analytics_dev",
  schemas: ["public", "audit", "reporting"],
  provisioner: "clean",
});

// Staging environment
export const stagingEnv = new Environment({
  displayName: "staging",
  url: "jdbc:postgresql://staging-analytics.internal:5432/analytics",
  schemas: ["public", "audit", "reporting"],
});

// Production environment
export const prodEnv = new Environment({
  displayName: "prod",
  url: "jdbc:postgresql://prod-analytics.internal:5432/analytics",
  schemas: ["public", "audit", "reporting"],
});

// Schema-specific placeholders for cross-schema references in SQL migrations.
// Migrations use ${audit_schema} instead of hardcoding schema names, so
// schemas can be remapped per environment if needed.
export const publicSchemaRef = new Placeholder({ key: "public_schema", value: "public" });
export const auditSchemaRef = new Placeholder({ key: "audit_schema", value: "audit" });
export const reportingSchemaRef = new Placeholder({ key: "reporting_schema", value: "reporting" });

// Application-level placeholders used in seed data and view definitions
export const retentionDays = new Placeholder({ key: "audit_retention_days", value: "90" });
export const reportRefreshInterval = new Placeholder({ key: "report_refresh_interval", value: "15 minutes" });
export const partitionCount = new Placeholder({ key: "audit_partition_count", value: "12" });
