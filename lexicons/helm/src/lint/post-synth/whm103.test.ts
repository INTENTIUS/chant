import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import type { SerializerResult } from "@intentius/chant/serializer";
import { whm103 } from "./whm103";

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

describe("WHM103: template syntax", () => {
  test("passes with balanced braces", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "templates/deploy.yaml": "name: {{ .Values.name }}\n",
    });
    expect(whm103.check(ctx)).toHaveLength(0);
  });

  test("fails with unbalanced braces (missing closing)", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "templates/deploy.yaml": "name: {{ .Values.name }\n",
    });
    const diags = whm103.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("Unbalanced");
    expect(diags[0].checkId).toBe("WHM103");
  });

  test("passes with multiple balanced expressions", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "templates/deploy.yaml": "name: {{ .Values.name }}\nimage: {{ .Values.image }}\n",
    });
    expect(whm103.check(ctx)).toHaveLength(0);
  });

  test("ignores non-template files", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "values.yaml": "name: {{ broken\n",
    });
    expect(whm103.check(ctx)).toHaveLength(0);
  });
});
