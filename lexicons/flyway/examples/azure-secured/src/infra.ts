// Azure AD-secured Flyway project: Azure Active Directory authentication
// for database credentials. Demonstrates the AzureAdResolver for managed
// identity or service principal authentication to Azure SQL / PostgreSQL.

import {
  FlywayProject,
  FlywayConfig,
  Environment,
  AzureAdResolver,
  resolve,
} from "@intentius/chant-lexicon-flyway";

export const project = new FlywayProject({
  id: "inventory-service",
  name: "inventory-service",
  databaseType: "sqlserver",
});

export const config = new FlywayConfig({
  locations: ["filesystem:sql/migrations"],
  defaultSchema: "dbo",
  cleanDisabled: true,
  validateMigrationNaming: true,
});

// Azure AD resolver — uses managed identity or service principal
// authentication to Azure SQL / PostgreSQL
export const azureAdResolver = new AzureAdResolver({
  tenantId: "${env.AZURE_TENANT_ID}",
  clientId: "${env.AZURE_CLIENT_ID}",
});

export const dev = new Environment({
  url: "jdbc:sqlserver://localhost:1433;databaseName=inventory_dev;encrypt=true;trustServerCertificate=true",
  user: "sa",
  password: "DevP@ssw0rd",
  schemas: ["dbo"],
  displayName: "dev",
});

export const staging = new Environment({
  url: "jdbc:sqlserver://inventory-staging.database.windows.net:1433;databaseName=inventory;encrypt=true",
  user: resolve("azuread", "user"),
  password: resolve("azuread", "password"),
  schemas: ["dbo"],
  displayName: "staging",
  cleanDisabled: true,
});

export const prod = new Environment({
  url: "jdbc:sqlserver://inventory-prod.database.windows.net:1433;databaseName=inventory;encrypt=true",
  user: resolve("azuread", "user"),
  password: resolve("azuread", "password"),
  schemas: ["dbo"],
  displayName: "prod",
  cleanDisabled: true,
  validateOnMigrate: true,
});
