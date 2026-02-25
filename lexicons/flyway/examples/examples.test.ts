import { describe, test, expect } from "bun:test";
import { build } from "../../../packages/core/src/build";
import { flywaySerializer } from "../src/serializer";
import { resolve } from "path";

const examplesDir = resolve(import.meta.dir);

function describeExample(name: string, checks?: (output: string) => void) {
  describe(`flyway ${name} example`, () => {
    const srcDir = resolve(examplesDir, name, "src");

    test("build produces valid Flyway TOML", async () => {
      const result = await build(srcDir, [flywaySerializer]);

      expect(result.errors).toHaveLength(0);

      const output = result.outputs.get("flyway");
      expect(output).toBeDefined();
      expect(output).toContain("[flyway]");
      expect(output).toContain("[environments.");

      if (checks) checks(output!);
    });
  });
}

describeExample("basic-project", (output) => {
  expect(output).toContain('databaseType = "postgresql"');
  expect(output).toContain("[environments.dev]");
});

describeExample("multi-environment", (output) => {
  expect(output).toContain("[environments.devEnv]");
  expect(output).toContain("[environments.stagingEnv]");
  expect(output).toContain("[environments.prodEnv]");
  expect(output).toContain("[environments.shadowEnv]");
});

describeExample("vault-secured", (output) => {
  expect(output).toContain("${vault.");
  expect(output).toContain("${localSecret.");
});

describeExample("docker-dev", (output) => {
  expect(output).toContain('provisioner = "docker"');
  expect(output).toContain("dockerImage");
});

describeExample("ci-pipeline", (output) => {
  expect(output).toContain("${env.DB_URL}");
  expect(output).toContain("${env.DB_USER}");
});

describeExample("multi-schema", (output) => {
  expect(output).toContain('schemas = ["public", "audit", "reporting"]');
});

describeExample("callbacks", (output) => {
  expect(output).toContain("callbackLocations");
});

describeExample("gcp-secured", (output) => {
  expect(output).toContain("${googlesecrets.");
});

describeExample("desktop-project", (output) => {
  expect(output).toContain("[flywayDesktop]");
  expect(output).toContain("schemaModelLocation");
  expect(output).toContain("[redgateCompare]");
});

describeExample("environment-overrides", (output) => {
  expect(output).toContain("[environments.devEnv.flyway]");
  expect(output).toContain("[environments.prodEnv.flyway]");
  expect(output).toContain("placeholders");
});
