import { describe, test, expect } from "bun:test";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import type { SerializerResult } from "@intentius/chant/serializer";
import { whm104 } from "./whm104";

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

describe("WHM104: NOTES.txt", () => {
  test("info when NOTES.txt is missing for application chart", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\ntype: application\n",
    });
    const diags = whm104.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe("info");
    expect(diags[0].checkId).toBe("WHM104");
  });

  test("passes for library charts without NOTES.txt", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\ntype: library\n",
    });
    expect(whm104.check(ctx)).toHaveLength(0);
  });

  test("passes when NOTES.txt exists", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\ntype: application\n",
      "templates/NOTES.txt": "Hello!",
    });
    expect(whm104.check(ctx)).toHaveLength(0);
  });

  test("info when type is absent (defaults to application)", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
    });
    const diags = whm104.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe("info");
  });
});
