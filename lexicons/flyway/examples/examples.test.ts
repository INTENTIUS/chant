import { expect } from "bun:test";
import { describeAllExamples } from "@intentius/chant-test-utils/example-harness";
import { flywaySerializer } from "@intentius/chant-lexicon-flyway";

describeAllExamples(
  {
    lexicon: "flyway",
    serializer: flywaySerializer,
    outputKey: "flyway",
    examplesDir: import.meta.dir,
  },
  {
    "basic-project": {
      skipLint: true,
      checks: (output) => {
        expect(output).toContain("[flyway]");
        expect(output).toContain("[environments.");
        expect(output).toContain('databaseType = "postgresql"');
        expect(output).toContain("[environments.dev]");
      },
    },
    "multi-environment": {
      skipLint: true,
      checks: (output) => {
        expect(output).toContain("[flyway]");
        expect(output).toContain("[environments.dev]");
        expect(output).toContain("[environments.staging]");
        expect(output).toContain("[environments.prod]");
        expect(output).toContain("[environments.shadow]");
      },
    },
    "vault-secured": {
      skipLint: true,
      checks: (output) => {
        expect(output).toContain("[flyway]");
        expect(output).toContain("${vault.");
        expect(output).toContain("${localSecret.");
      },
    },
    "docker-dev": {
      skipLint: true,
      checks: (output) => {
        expect(output).toContain("[flyway]");
        expect(output).toContain('provisioner = "docker"');
        expect(output).toContain("dockerImage");
      },
    },
    "ci-pipeline": {
      skipLint: true,
      checks: (output) => {
        expect(output).toContain("[flyway]");
        expect(output).toContain("${env.DB_URL}");
        expect(output).toContain("${env.DB_USER}");
      },
    },
    "multi-schema": {
      skipLint: true,
      checks: (output) => {
        expect(output).toContain("[flyway]");
        expect(output).toContain('schemas = ["public", "audit", "reporting"]');
      },
    },
    "callbacks": {
      skipLint: true,
      checks: (output) => {
        expect(output).toContain("[flyway]");
        expect(output).toContain("callbackLocations");
      },
    },
    "gcp-secured": {
      skipLint: true,
      checks: (output) => {
        expect(output).toContain("[flyway]");
        expect(output).toContain("${googlesecrets.");
      },
    },
    "desktop-project": {
      skipLint: true,
      checks: (output) => {
        expect(output).toContain("[flywayDesktop]");
        expect(output).toContain("schemaModelLocation");
        expect(output).toContain("[redgateCompare]");
      },
    },
    "environment-overrides": {
      skipLint: true,
      checks: (output) => {
        expect(output).toContain("[flyway]");
        expect(output).toContain("[environments.dev.flyway]");
        expect(output).toContain("[environments.prod.flyway]");
        expect(output).toContain("placeholders");
      },
    },
    "migration-lifecycle": {
      skipLint: true,
      checks: (output) => {
        expect(output).toContain("[flyway]");
        expect(output).toContain("[environments.dev]");
        expect(output).toContain("[environments.shadow]");
        expect(output).toContain("[environments.prod]");
        expect(output).toContain("[environments.dev.flyway]");
        expect(output).toContain("[environments.prod.flyway]");
        expect(output).toContain("cleanDisabled = false");
        expect(output).toContain("validateOnMigrate = true");
      },
    },
    "azure-secured": {
      skipLint: true,
      checks: (output) => {
        expect(output).toContain("[flyway]");
        expect(output).toContain("[environments.");
      },
    },
  },
);
