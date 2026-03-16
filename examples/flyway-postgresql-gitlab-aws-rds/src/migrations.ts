import {
  FlywayProject,
  FlywayConfig,
  Environment,
} from "@intentius/chant-lexicon-flyway";

export const project = new FlywayProject({ name: "flyway-rds", databaseType: "postgresql" });

export const config = new FlywayConfig({
  locations: ["filesystem:sql/migrations"],
  defaultSchema: "public",
  validateMigrationNaming: true,
});

// Deploy environment — connects to RDS via env vars set by the GitLab pipeline.
// ${env.*} references use Flyway's built-in env var resolution.
export const deploy = new Environment({
  url: "jdbc:postgresql://${env.DB_HOST}:5432/myapp",
  user: "postgres",
  password: "${env.DB_PASSWORD}",
  schemas: ["public"],
});
