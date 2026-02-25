import { describe, test, expect } from "bun:test";
import { build } from "../../../../packages/core/src/build";
import { resolve } from "path";
import { k8sSerializer } from "../../src/serializer";

const srcDir = resolve(import.meta.dir, "src");

describe("statefulset example", () => {
  test("build produces valid K8s YAML", async () => {
    const result = await build(srcDir, [k8sSerializer]);

    expect(result.errors).toHaveLength(0);

    const output = result.outputs.get("k8s");
    expect(output).toBeDefined();

    expect(output).toContain("kind: StatefulSet");
    expect(output).toContain("kind: Service");
    expect(output).toContain("kind: PersistentVolumeClaim");
    expect(output).toContain("serviceName: postgres-headless");
  });
});
