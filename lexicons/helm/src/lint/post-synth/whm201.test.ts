import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import type { SerializerResult } from "@intentius/chant/serializer";
import { whm201 } from "./whm201";

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

describe("WHM201: standard labels", () => {
  test("info when template lacks labels", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "templates/deploy.yaml": "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: test\n",
    });
    const diags = whm201.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WHM201");
    expect(diags[0].severity).toBe("info");
  });

  test("passes when template includes labels helper", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "templates/deploy.yaml": 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  labels: {{ include "test.labels" . }}\n',
    });
    expect(whm201.check(ctx)).toHaveLength(0);
  });

  test("passes when template has helm.sh/chart annotation", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "templates/deploy.yaml": "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  labels:\n    helm.sh/chart: test\n",
    });
    expect(whm201.check(ctx)).toHaveLength(0);
  });

  test("skips _helpers.tpl and NOTES.txt", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "templates/_helpers.tpl": "kind: something\n",
      "templates/NOTES.txt": "kind: something\n",
    });
    expect(whm201.check(ctx)).toHaveLength(0);
  });
});
