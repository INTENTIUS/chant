import { describe, test, expect } from "bun:test";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import type { SerializerResult } from "@intentius/chant/serializer";
import { whm203 } from "./whm203";

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

describe("WHM203: values documentation", () => {
  test("info when values exist but no schema", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "values.yaml": "replicaCount: 1\n",
    });
    const diags = whm203.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WHM203");
    expect(diags[0].severity).toBe("info");
  });

  test("passes when schema exists", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "values.yaml": "replicaCount: 1\n",
      "values.schema.json": '{"type":"object"}',
    });
    expect(whm203.check(ctx)).toHaveLength(0);
  });

  test("passes when values.yaml is empty object", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "values.yaml": "{}",
    });
    expect(whm203.check(ctx)).toHaveLength(0);
  });

  test("passes when no values.yaml exists", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
    });
    expect(whm203.check(ctx)).toHaveLength(0);
  });
});
