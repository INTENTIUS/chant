// CI/CD pipeline project: environment-variable credentials, baseline-on-migrate
// for initial deployments, strict validation for migration integrity checks.
// Demonstrates the CiPipelineProject composite and the env intrinsic.

import {
  CiPipelineProject,
  FlywayProject,
  FlywayConfig,
  Environment,
  env,
} from "@intentius/chant-lexicon-flyway";

const result = CiPipelineProject({
  name: "user-service",
  databaseType: "postgresql",
  envVarPrefix: "DB",
  environmentName: "ci",
  schemas: ["public", "users"],
  locations: ["filesystem:sql"],
  defaults: {
    config: {
      baselineOnMigrate: true,
      baselineVersion: "0",
      baselineDescription: "Initial baseline from existing schema",
    },
  },
});

export const project = result.project;

export const ciEnv = result.environment;

export const config = result.config;

// Additional staging environment also using env vars with a different prefix
export const stagingEnv = new Environment({
  displayName: "staging",
  url: env("STAGING_DB_URL"),
  user: env("STAGING_DB_USER"),
  password: env("STAGING_DB_PASSWORD"),
  schemas: ["public", "users"],
});

// Production environment with stricter settings
export const prodEnv = new Environment({
  displayName: "prod",
  url: env("PROD_DB_URL"),
  user: env("PROD_DB_USER"),
  password: env("PROD_DB_PASSWORD"),
  schemas: ["public", "users"],
  cleanDisabled: true,
});
