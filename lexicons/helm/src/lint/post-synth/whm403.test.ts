import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import type { SerializerResult } from "@intentius/chant/serializer";
import { whm403 } from "./whm403";

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

describe("WHM403: readOnlyRootFilesystem", () => {
  test("info when containers lack readOnlyRootFilesystem", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "templates/deploy.yaml": "kind: Deployment\nspec:\n  containers:\n    - name: app\n",
    });
    const diags = whm403.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WHM403");
    expect(diags[0].severity).toBe("info");
  });

  test("passes with readOnlyRootFilesystem: true", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "templates/deploy.yaml": "kind: Deployment\nspec:\n  containers:\n    - name: app\n  securityContext:\n    readOnlyRootFilesystem: true\n",
    });
    expect(whm403.check(ctx)).toHaveLength(0);
  });

  test("passes with .Values.securityContext ref", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "templates/deploy.yaml": "kind: Deployment\nspec:\n  containers:\n    - name: app\n  securityContext: {{ toYaml .Values.securityContext }}\n",
    });
    expect(whm403.check(ctx)).toHaveLength(0);
  });
});
