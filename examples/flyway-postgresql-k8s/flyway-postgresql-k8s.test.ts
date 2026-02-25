import { describe, test, expect } from "bun:test";
import { lintCommand } from "../../packages/core/src/cli/commands/lint";
import { build } from "../../packages/core/src/build";
import { resolve } from "path";
import { k8sSerializer } from "../../lexicons/k8s/src/serializer";
import { flywaySerializer } from "../../lexicons/flyway/src/serializer";

const srcDir = resolve(import.meta.dir, "src");

describe("flyway-postgresql-k8s example", () => {
  test("passes strict lint", async () => {
    const result = await lintCommand({
      path: srcDir,
      format: "stylish",
      fix: true,
    });

    if (!result.success || result.errorCount > 0 || result.warningCount > 0) {
      console.log(result.output);
    }

    expect(result.success).toBe(true);
    expect(result.errorCount).toBe(0);
    expect(result.warningCount).toBe(0);
  });

  test("build produces valid K8s manifests and Flyway config", async () => {
    const result = await build(srcDir, [k8sSerializer, flywaySerializer]);

    expect(result.errors).toHaveLength(0);

    // K8s output
    const k8s = result.outputs.get("k8s");
    expect(k8s).toBeDefined();
    expect(k8s).toContain("kind: Namespace");
    expect(k8s).toContain("kind: StatefulSet");
    expect(k8s).toContain("kind: Service");
    expect(k8s).toContain("nodePort: 30432");

    // Flyway output
    const flyway = result.outputs.get("flyway");
    expect(flyway).toBeDefined();
    expect(flyway).toContain("[flyway]");
    expect(flyway).toContain("[environments.local]");
    expect(flyway).toContain("jdbc:postgresql://localhost:30432/app");
  });
});
