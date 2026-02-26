// GCP-secured Flyway project: Google Cloud Secret Manager for credentials,
// Cloud SQL PostgreSQL instances for staging and production.
// Demonstrates the GcpSecuredProject composite.

import {
  GcpSecuredProject,
  FlywayProject,
  FlywayConfig,
  Environment,
  GcpResolver,
} from "@intentius/chant-lexicon-flyway";

const result = GcpSecuredProject({
  name: "catalog-service",
  databaseType: "postgresql",
  gcpProject: "acme-prod-297614",
  environments: [
    {
      name: "staging",
      url: "jdbc:postgresql:///catalog?cloudSqlInstance=acme-prod-297614:us-central1:catalog-staging&socketFactory=com.google.cloud.sql.postgres.SocketFactory",
      userSecret: "catalog-staging-db-user",
      passwordSecret: "catalog-staging-db-password",
      schemas: ["public", "catalog"],
    },
    {
      name: "prod",
      url: "jdbc:postgresql:///catalog?cloudSqlInstance=acme-prod-297614:us-central1:catalog-prod&socketFactory=com.google.cloud.sql.postgres.SocketFactory",
      userSecret: "catalog-prod-db-user",
      passwordSecret: "catalog-prod-db-password",
      schemas: ["public", "catalog"],
    },
  ],
  schemas: ["public", "catalog"],
  locations: ["filesystem:sql"],
});

export const project = new FlywayProject(result.project);

export const config = new FlywayConfig({
  ...result.config,
  cleanDisabled: true,
  validateOnMigrate: true,
  outOfOrder: false,
});

export const gcpResolver = new GcpResolver(result.gcpResolver);

export const stagingEnv = new Environment(result.environments.staging);

export const prodEnv = new Environment(result.environments.prod);

// Local dev environment does not use GCP secrets
export const devEnv = new Environment({
  displayName: "dev",
  url: "jdbc:postgresql://localhost:5432/catalog_dev",
  user: "catalog_dev",
  password: "dev_password",
  schemas: ["public", "catalog"],
  provisioner: "clean",
});
