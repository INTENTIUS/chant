import { FlywayProject, FlywayConfig, Environment } from "@intentius/chant-lexicon-flyway";
export const project = new FlywayProject({
  name: "smoke-test-db",
});
export const config = new FlywayConfig({
  locations: ["filesystem:sql/migrations"],
  defaultSchema: "public",
  schemas: ["public", "audit"],
  encoding: "UTF-8",
  validateMigrationNaming: true,
  cleanDisabled: true,
  baselineOnMigrate: false,
  baselineVersion: "1",
  table: "flyway_schema_history",
});
export const dev = new Environment({
  name: "dev",
  url: "jdbc:postgresql://localhost:5432/mydb",
  user: "dev_user",
  schemas: ["public"],
});
