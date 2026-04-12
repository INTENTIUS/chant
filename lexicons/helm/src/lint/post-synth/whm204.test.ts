import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import type { SerializerResult } from "@intentius/chant/serializer";
import { whm204 } from "./whm204";

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

describe("WHM204: dependency semver ranges", () => {
  test("info when dependency uses pinned version", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\ndependencies:\n  - name: redis\n    version: 1.2.3\n    repository: https://charts.bitnami.com\n",
    });
    const diags = whm204.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WHM204");
    expect(diags[0].severity).toBe("info");
    expect(diags[0].message).toContain("redis");
    expect(diags[0].message).toContain("1.2.3");
  });

  test("passes when dependency uses tilde range", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\ndependencies:\n  - name: redis\n    version: ~1.2.3\n    repository: https://charts.bitnami.com\n",
    });
    expect(whm204.check(ctx)).toHaveLength(0);
  });

  test("passes when dependency uses caret range", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\ndependencies:\n  - name: redis\n    version: ^1.2.3\n    repository: https://charts.bitnami.com\n",
    });
    expect(whm204.check(ctx)).toHaveLength(0);
  });

  test("passes when no dependencies section", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
    });
    expect(whm204.check(ctx)).toHaveLength(0);
  });
});
