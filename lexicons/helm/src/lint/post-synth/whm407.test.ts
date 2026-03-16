import { describe, test, expect } from "bun:test";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import type { SerializerResult } from "@intentius/chant/serializer";
import { whm407 } from "./whm407";

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

describe("WHM407: inline secrets", () => {
  test("warns on Secret with inline data", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "templates/secret.yaml": "apiVersion: v1\nkind: Secret\nmetadata:\n  name: my-secret\ndata:\n  password: c2VjcmV0\n",
    });
    const diags = whm407.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WHM407");
    expect(diags[0].severity).toBe("warning");
  });

  test("passes when ExternalSecret is used in chart", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "templates/secret.yaml": "apiVersion: v1\nkind: Secret\nmetadata:\n  name: my-secret\ndata:\n  password: c2VjcmV0\n",
      "templates/external-secret.yaml": "apiVersion: external-secrets.io/v1beta1\nkind: ExternalSecret\n",
    });
    expect(whm407.check(ctx)).toHaveLength(0);
  });

  test("passes when data uses template values", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "templates/secret.yaml": "apiVersion: v1\nkind: Secret\nmetadata:\n  name: my-secret\ndata:\n  password: {{ .Values.secret.password }}\n",
    });
    expect(whm407.check(ctx)).toHaveLength(0);
  });

  test("passes when SealedSecret is present", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "templates/secret.yaml": "apiVersion: v1\nkind: Secret\nmetadata:\n  name: my-secret\ndata:\n  password: c2VjcmV0\n",
      "templates/sealed.yaml": "kind: SealedSecret\n",
    });
    expect(whm407.check(ctx)).toHaveLength(0);
  });
});
