import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import type { SerializerResult } from "@intentius/chant/serializer";
import { whm402 } from "./whm402";

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

describe("WHM402: runAsNonRoot", () => {
  test("warns when containers lack runAsNonRoot", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "templates/deploy.yaml": "kind: Deployment\nspec:\n  containers:\n    - name: app\n",
    });
    const diags = whm402.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WHM402");
    expect(diags[0].severity).toBe("warning");
  });

  test("passes with runAsNonRoot: true", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "templates/deploy.yaml": "kind: Deployment\nspec:\n  containers:\n    - name: app\n  securityContext:\n    runAsNonRoot: true\n",
    });
    expect(whm402.check(ctx)).toHaveLength(0);
  });

  test("passes with .Values.securityContext ref", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "templates/deploy.yaml": "kind: Deployment\nspec:\n  containers:\n    - name: app\n  securityContext: {{ toYaml .Values.securityContext }}\n",
    });
    expect(whm402.check(ctx)).toHaveLength(0);
  });

  test("passes with .Values.podSecurityContext ref", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "templates/deploy.yaml": "kind: Deployment\nspec:\n  containers:\n    - name: app\n  securityContext: {{ toYaml .Values.podSecurityContext }}\n",
    });
    expect(whm402.check(ctx)).toHaveLength(0);
  });
});
