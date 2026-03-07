import { describe, test, expect } from "bun:test";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import type { SerializerResult } from "@intentius/chant/serializer";
import { whm405 } from "./whm405";

function makeCtx(files: Record<string, string>): PostSynthContext {
  const result: SerializerResult = { primary: files["Chart.yaml"] ?? "", files };
  const outputs = new Map<string, string | SerializerResult>();
  outputs.set("helm", result);
  return {
    outputs,
    entities: new Map(),
    buildResult: {
      outputs,
      entities: new Map(),
      warnings: [],
      errors: [],
      sourceFileCount: 1,
    },
  };
}

describe("WHM405: resource spec detail", () => {
  test("warns when resources lack cpu", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "templates/deploy.yaml": "kind: Deployment\nspec:\n  containers:\n    - name: app\n      resources:\n        limits:\n          memory: 256Mi\n",
    });
    const diags = whm405.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WHM405");
    expect(diags[0].message).toContain("cpu");
  });

  test("passes with both cpu and memory", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "templates/deploy.yaml": "kind: Deployment\nspec:\n  containers:\n    - name: app\n      resources:\n        limits:\n          cpu: 100m\n          memory: 256Mi\n",
    });
    expect(whm405.check(ctx)).toHaveLength(0);
  });

  test("passes when resources use .Values", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "templates/deploy.yaml": "kind: Deployment\nspec:\n  containers:\n    - name: app\n      resources: {{ toYaml .Values.resources }}\n",
    });
    expect(whm405.check(ctx)).toHaveLength(0);
  });

  test("warns when resources lack memory", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "templates/deploy.yaml": "kind: Deployment\nspec:\n  containers:\n    - name: app\n      resources:\n        limits:\n          cpu: 100m\n",
    });
    const diags = whm405.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("memory");
  });
});
