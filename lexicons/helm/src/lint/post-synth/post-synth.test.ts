import { describe, test, expect } from "vitest";
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
import { whm401 } from "./whm401";
import { whm402 } from "./whm402";
import { whm403 } from "./whm403";
import { whm404 } from "./whm404";
import { whm405 } from "./whm405";
import { whm406 } from "./whm406";
import { whm407 } from "./whm407";
import { whm501 } from "./whm501";
import { whm502 } from "./whm502";
import { whm005 } from "./whm005-no-empty-wrapper";

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

describe("WHM005: noEmptyWrapperChart", () => {
  test("warns when chart has HelmDependency but no templates", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "Chart.yaml.deps": "",
      "templates/_helpers.tpl": "{{/* helpers */}}",
    });
    // Inject dependencies block
    const files = {
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\ndependencies:\n  - name: gitlab\n    version: 8.7.2\n    repository: https://charts.gitlab.io\n",
      "templates/_helpers.tpl": "{{/* helpers */}}",
    };
    const ctx2 = makeCtx(files);
    const diags = whm005.check(ctx2);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WHM005");
    expect(diags[0].severity).toBe("warning");
  });

  test("passes when chart has dependencies and templates", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\ndependencies:\n  - name: gitlab\n    version: 8.7.2\n    repository: https://charts.gitlab.io\n",
      "templates/_helpers.tpl": "{{/* helpers */}}",
      "templates/deployment.yaml": "apiVersion: apps/v1\nkind: Deployment\n",
    });
    expect(whm005.check(ctx)).toHaveLength(0);
  });

  test("passes when chart has no dependencies", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "templates/deployment.yaml": "apiVersion: apps/v1\nkind: Deployment\n",
    });
    expect(whm005.check(ctx)).toHaveLength(0);
  });

  test("passes when no Chart.yaml present", () => {
    const ctx = makeCtx({});
    expect(whm005.check(ctx)).toHaveLength(0);
  });
});

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

describe("WHM401: image tag", () => {
  test("warns on :latest tag", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "templates/deploy.yaml": "kind: Deployment\nspec:\n  containers:\n    - name: app\n      image: nginx:latest\n",
    });
    const diags = whm401.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WHM401");
    expect(diags[0].severity).toBe("warning");
  });

  test("warns on untagged image", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "templates/deploy.yaml": "kind: Deployment\nspec:\n  containers:\n    - name: app\n      image: nginx\n",
    });
    const diags = whm401.check(ctx);
    expect(diags).toHaveLength(1);
  });

  test("passes with pinned tag", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "templates/deploy.yaml": "kind: Deployment\nspec:\n  containers:\n    - name: app\n      image: nginx:1.25.0\n",
    });
    expect(whm401.check(ctx)).toHaveLength(0);
  });

  test("passes with .Values reference", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "templates/deploy.yaml": "kind: Deployment\nspec:\n  containers:\n    - name: app\n      image: {{ .Values.image.repository }}:{{ .Values.image.tag }}\n",
    });
    expect(whm401.check(ctx)).toHaveLength(0);
  });
});

describe("WHM402: runAsNonRoot", () => {
  test("warns when containers lack runAsNonRoot", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "templates/deploy.yaml": "kind: Deployment\nspec:\n  containers:\n    - name: app\n",
    });
    const diags = whm402.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WHM402");
    expect(diags[0].severity).toBe("warning");
  });

  test("passes with runAsNonRoot: true", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "templates/deploy.yaml": "kind: Deployment\nspec:\n  containers:\n    - name: app\n  securityContext:\n    runAsNonRoot: true\n",
    });
    expect(whm402.check(ctx)).toHaveLength(0);
  });

  test("passes with .Values.securityContext ref", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "templates/deploy.yaml": "kind: Deployment\nspec:\n  containers:\n    - name: app\n  securityContext: {{ toYaml .Values.securityContext }}\n",
    });
    expect(whm402.check(ctx)).toHaveLength(0);
  });
});

describe("WHM403: readOnlyRootFilesystem", () => {
  test("info when containers lack readOnlyRootFilesystem", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "templates/deploy.yaml": "kind: Deployment\nspec:\n  containers:\n    - name: app\n",
    });
    const diags = whm403.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe("info");
  });

  test("passes with readOnlyRootFilesystem: true", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "templates/deploy.yaml": "kind: Deployment\nspec:\n  containers:\n    - name: app\n  securityContext:\n    readOnlyRootFilesystem: true\n",
    });
    expect(whm403.check(ctx)).toHaveLength(0);
  });
});

describe("WHM404: privileged mode", () => {
  test("error on privileged: true", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "templates/deploy.yaml": "kind: Deployment\nspec:\n  containers:\n    - name: app\n      securityContext:\n        privileged: true\n",
    });
    const diags = whm404.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe("error");
  });

  test("passes without privileged mode", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "templates/deploy.yaml": "kind: Deployment\nspec:\n  containers:\n    - name: app\n",
    });
    expect(whm404.check(ctx)).toHaveLength(0);
  });
});

describe("WHM405: resource spec detail", () => {
  test("warns when resources lack cpu", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "templates/deploy.yaml": "kind: Deployment\nspec:\n  containers:\n    - name: app\n      resources:\n        limits:\n          memory: 256Mi\n",
    });
    const diags = whm405.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WHM405");
  });

  test("passes with both cpu and memory", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "templates/deploy.yaml": "kind: Deployment\nspec:\n  containers:\n    - name: app\n      resources:\n        limits:\n          cpu: 100m\n          memory: 256Mi\n",
    });
    expect(whm405.check(ctx)).toHaveLength(0);
  });

  test("passes when resources use .Values", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "templates/deploy.yaml": "kind: Deployment\nspec:\n  containers:\n    - name: app\n      resources: {{ toYaml .Values.resources }}\n",
    });
    expect(whm405.check(ctx)).toHaveLength(0);
  });
});

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
  });

  test("passes without crds/ directory", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "templates/deploy.yaml": "kind: Deployment\n",
    });
    expect(whm406.check(ctx)).toHaveLength(0);
  });
});

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
});

describe("WHM501: unused values", () => {
  test("info on values key not referenced in templates", () => {
    const ctx = makeCtx({
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "values.yaml": "replicaCount: 1\nunusedKey: hello\n",
      "templates/deploy.yaml": "replicas: {{ .Values.replicaCount }}\n",
    });
    const diags = whm501.check(ctx);
    expect(diags.some((d) => d.message.includes("unusedKey"))).toBe(true);
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
      "values.yaml": "nameOverride: \"\"\nfullnameOverride: \"\"\n",
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
});
