import { describe, test, expect } from "bun:test";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import type { SerializerResult } from "@intentius/chant/serializer";
import { whm502 } from "./whm502";

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

describe("WHM502: deprecated API versions", () => {
  test("warns on extensions/v1beta1 Ingress", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "templates/ingress.yaml": "apiVersion: extensions/v1beta1\nkind: Ingress\n",
    });
    const diags = whm502.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WHM502");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("networking.k8s.io/v1");
  });

  test("warns on apps/v1beta2", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "templates/deploy.yaml": "apiVersion: apps/v1beta2\nkind: Deployment\n",
    });
    const diags = whm502.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("apps/v1");
  });

  test("passes with current API versions", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "templates/deploy.yaml": "apiVersion: apps/v1\nkind: Deployment\n",
      "templates/ingress.yaml": "apiVersion: networking.k8s.io/v1\nkind: Ingress\n",
    });
    expect(whm502.check(ctx)).toHaveLength(0);
  });

  test("skips template expression apiVersions", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "templates/deploy.yaml": "apiVersion: {{ .Capabilities.APIVersions }}\nkind: Deployment\n",
    });
    expect(whm502.check(ctx)).toHaveLength(0);
  });

  test("warns on batch/v1beta1 CronJob", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "templates/cron.yaml": "apiVersion: batch/v1beta1\nkind: CronJob\n",
    });
    const diags = whm502.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("batch/v1");
  });
});
