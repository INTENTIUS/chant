import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import type { SerializerResult } from "@intentius/chant/serializer";
import { whm202 } from "./whm202";

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

describe("WHM202: hook weights", () => {
  test("warns when multiple hooks exist and some lack weights", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "templates/pre-install.yaml": "helm.sh/hook: pre-install\nhelm.sh/hook-weight: \"-5\"\n",
      "templates/post-install.yaml": "helm.sh/hook: post-install\n",
    });
    const diags = whm202.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WHM202");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("hook-weight");
  });

  test("passes when all hooks have weights", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "templates/pre-install.yaml": "helm.sh/hook: pre-install\nhelm.sh/hook-weight: \"-5\"\n",
      "templates/post-install.yaml": "helm.sh/hook: post-install\nhelm.sh/hook-weight: \"5\"\n",
    });
    expect(whm202.check(ctx)).toHaveLength(0);
  });

  test("passes with a single hook without weight", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "templates/pre-install.yaml": "helm.sh/hook: pre-install\n",
    });
    expect(whm202.check(ctx)).toHaveLength(0);
  });

  test("ignores test hooks", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "templates/test.yaml": "helm.sh/hook: test\n",
      "templates/pre-install.yaml": "helm.sh/hook: pre-install\n",
    });
    expect(whm202.check(ctx)).toHaveLength(0);
  });
});
