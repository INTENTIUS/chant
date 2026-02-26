import { describe, test, expect } from "bun:test";
import type { PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import type { SerializerResult } from "@intentius/chant/serializer";
import { whm101 } from "./whm101";
import { whm102 } from "./whm102";
import { whm103 } from "./whm103";
import { whm104 } from "./whm104";
import { whm105 } from "./whm105";
import { whm201 } from "./whm201";
import { whm301 } from "./whm301";
import { whm302 } from "./whm302";

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
});

describe("WHM102: values.schema.json", () => {
  test("passes when schema exists", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "values.yaml": "replicaCount: 1\n",
      "values.schema.json": "{}",
    });
    expect(whm102.check(ctx)).toHaveLength(0);
  });

  test("warns when values are non-empty but schema is missing", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "values.yaml": "replicaCount: 1\n",
    });
    const diags = whm102.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WHM102");
  });

  test("passes when values.yaml is empty", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "values.yaml": "{}",
    });
    expect(whm102.check(ctx)).toHaveLength(0);
  });
});

describe("WHM103: template syntax", () => {
  test("passes with balanced braces", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "templates/deploy.yaml": "name: {{ .Values.name }}\n",
    });
    expect(whm103.check(ctx)).toHaveLength(0);
  });

  test("fails with unbalanced braces", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "templates/deploy.yaml": "name: {{ .Values.name }\n",
    });
    const diags = whm103.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("Unbalanced");
  });
});

describe("WHM104: NOTES.txt", () => {
  test("info when NOTES.txt is missing for application chart", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\ntype: application\n",
    });
    const diags = whm104.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe("info");
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
});

describe("WHM105: _helpers.tpl", () => {
  test("warns when _helpers.tpl is missing", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
    });
    const diags = whm105.check(ctx);
    expect(diags).toHaveLength(1);
  });

  test("passes when _helpers.tpl exists", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "templates/_helpers.tpl": "{{/* helpers */}}",
    });
    expect(whm105.check(ctx)).toHaveLength(0);
  });
});

describe("WHM201: standard labels", () => {
  test("info when template lacks labels", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "templates/deploy.yaml": "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: test\n",
    });
    const diags = whm201.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WHM201");
  });

  test("passes when template includes labels helper", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "templates/deploy.yaml": 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  labels: {{ include "test.labels" . }}\n',
    });
    expect(whm201.check(ctx)).toHaveLength(0);
  });
});

describe("WHM301: Helm tests", () => {
  test("info when no tests defined", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\ntype: application\n",
      "templates/deploy.yaml": "kind: Deployment\n",
    });
    const diags = whm301.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WHM301");
  });

  test("passes when test exists", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\ntype: application\n",
      "templates/tests/test-connection.yaml": "helm.sh/hook: test\n",
    });
    expect(whm301.check(ctx)).toHaveLength(0);
  });
});

describe("WHM302: resource limits", () => {
  test("info when containers lack resources", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "templates/deploy.yaml": "kind: Deployment\nspec:\n  containers:\n    - name: app\n",
    });
    const diags = whm302.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WHM302");
  });

  test("passes when resources are set", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "templates/deploy.yaml": "kind: Deployment\nspec:\n  containers:\n    - name: app\n      resources:\n        limits:\n          cpu: 100m\n",
    });
    expect(whm302.check(ctx)).toHaveLength(0);
  });

  test("passes when resources use values reference", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "templates/deploy.yaml": "kind: Deployment\nspec:\n  containers:\n    - name: app\n      resources: {{ toYaml .Values.resources }}\n",
    });
    expect(whm302.check(ctx)).toHaveLength(0);
  });
});
