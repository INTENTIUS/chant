import { describe, test, expect } from "bun:test";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import type { SerializerResult } from "@intentius/chant/serializer";
import { whm102 } from "./whm102";

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

describe("WHM102: values.schema.json", () => {
  test("passes when schema exists", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "values.yaml": "replicaCount: 1\n",
      "values.schema.json": "{}",
    });
    expect(whm102.check(ctx)).toHaveLength(0);
  });

  test("warns when values are non-empty but schema is missing", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "values.yaml": "replicaCount: 1\n",
    });
    const diags = whm102.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WHM102");
  });

  test("passes when values.yaml is empty object", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "values.yaml": "{}",
    });
    expect(whm102.check(ctx)).toHaveLength(0);
  });

  test("passes when values.yaml is absent", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
    });
    expect(whm102.check(ctx)).toHaveLength(0);
  });
});
