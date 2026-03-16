import { describe, test, expect } from "bun:test";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import type { SerializerResult } from "@intentius/chant/serializer";
import { whm301 } from "./whm301";

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

describe("WHM301: Helm tests", () => {
  test("info when no tests defined for application chart", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\ntype: application\n",
      "templates/deploy.yaml": "kind: Deployment\n",
    });
    const diags = whm301.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WHM301");
    expect(diags[0].severity).toBe("info");
  });

  test("passes when test exists", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\ntype: application\n",
      "templates/tests/test-connection.yaml": "helm.sh/hook: test\n",
    });
    expect(whm301.check(ctx)).toHaveLength(0);
  });

  test("skips library charts", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\ntype: library\n",
    });
    expect(whm301.check(ctx)).toHaveLength(0);
  });
});
