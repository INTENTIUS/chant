import { describe, test, expect } from "bun:test";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import type { SerializerResult } from "@intentius/chant/serializer";
import { whm101 } from "./whm101";

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

describe("WHM101: Chart.yaml validation", () => {
  test("passes with valid Chart.yaml", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
    });
    expect(whm101.check(ctx)).toHaveLength(0);
  });

  test("fails when Chart.yaml is missing", () => {
    const ctx = makeCtx({});
    const diags = whm101.check(ctx);
    expect(diags.length).toBeGreaterThan(0);
    expect(diags[0].message).toContain("missing");
  });

  test("fails when apiVersion is not v2", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v1\nname: test\nversion: 0.1.0\n",
    });
    const diags = whm101.check(ctx);
    expect(diags.some((d) => d.message.includes("v2"))).toBe(true);
  });

  test("fails when name is missing", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nversion: 0.1.0\n",
    });
    const diags = whm101.check(ctx);
    expect(diags.some((d) => d.message.includes("name"))).toBe(true);
  });

  test("fails when version is missing", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\n",
    });
    const diags = whm101.check(ctx);
    expect(diags.some((d) => d.message.includes("version"))).toBe(true);
  });

  test("all diagnostics have checkId WHM101", () => {
    const ctx = makeCtx({});
    const diags = whm101.check(ctx);
    for (const d of diags) {
      expect(d.checkId).toBe("WHM101");
    }
  });
});
