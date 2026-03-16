import { describe, test, expect } from "bun:test";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import type { SerializerResult } from "@intentius/chant/serializer";
import { whm406 } from "./whm406";

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

describe("WHM406: CRD lifecycle", () => {
  test("info when crds/ directory exists", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "crds/my-crd.yaml": "apiVersion: apiextensions.k8s.io/v1\nkind: CustomResourceDefinition\n",
    });
    const diags = whm406.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WHM406");
    expect(diags[0].severity).toBe("info");
    expect(diags[0].message).toContain("CRD");
  });

  test("passes without crds/ directory", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "templates/deploy.yaml": "kind: Deployment\n",
    });
    expect(whm406.check(ctx)).toHaveLength(0);
  });
});
