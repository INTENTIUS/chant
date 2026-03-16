import { describe, test, expect } from "bun:test";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import type { SerializerResult } from "@intentius/chant/serializer";
import { whm501 } from "./whm501";

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

describe("WHM501: unused values", () => {
  test("info on values key not referenced in templates", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "values.yaml": "replicaCount: 1\nunusedKey: hello\n",
      "templates/deploy.yaml": "replicas: {{ .Values.replicaCount }}\n",
    });
    const diags = whm501.check(ctx);
    expect(diags.some((d) => d.message.includes("unusedKey"))).toBe(true);
    expect(diags[0].checkId).toBe("WHM501");
    expect(diags[0].severity).toBe("info");
  });

  test("passes when all values are referenced", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "values.yaml": "replicaCount: 1\n",
      "templates/deploy.yaml": "replicas: {{ .Values.replicaCount }}\n",
    });
    expect(whm501.check(ctx)).toHaveLength(0);
  });

  test("excludes nameOverride and fullnameOverride", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "values.yaml": 'nameOverride: ""\nfullnameOverride: ""\n',
      "templates/deploy.yaml": "kind: Deployment\n",
    });
    expect(whm501.check(ctx)).toHaveLength(0);
  });

  test("parent key is not unused when child is referenced", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "values.yaml": "image:\n  repository: nginx\n  tag: latest\n",
      "templates/deploy.yaml": "image: {{ .Values.image.repository }}:{{ .Values.image.tag }}\n",
    });
    expect(whm501.check(ctx)).toHaveLength(0);
  });

  test("passes with empty values", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "values.yaml": "{}\n",
    });
    expect(whm501.check(ctx)).toHaveLength(0);
  });
});
