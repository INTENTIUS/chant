import { describe, test, expect } from "vitest";
import { stripTemplateExpressions, classifyExpression } from "./template-stripper";
import { HelmParser } from "./parser";
import { HelmGenerator } from "./generator";

describe("template-stripper", () => {
  test("strips inline expressions and replaces with placeholders", () => {
    const template = `name: {{ .Values.name }}\nport: {{ .Values.service.port }}`;
    const result = stripTemplateExpressions(template);
    expect(result.yaml).toContain("__HELM_PLACEHOLDER0__");
    expect(result.yaml).toContain("__HELM_PLACEHOLDER1__");
    expect(result.expressions.size).toBe(2);
  });

  test("removes standalone block directives", () => {
    const template = `{{- if .Values.ingress.enabled }}\napiVersion: v1\n{{- end }}`;
    const result = stripTemplateExpressions(template);
    expect(result.yaml).not.toContain("if .Values");
    expect(result.yaml).not.toContain("end");
    expect(result.yaml).toContain("apiVersion: v1");
    expect(result.blockDirectives).toHaveLength(2);
  });

  test("handles whitespace-trimming markers", () => {
    const template = `name: {{- .Values.name -}}`;
    const result = stripTemplateExpressions(template);
    expect(result.expressions.size).toBe(1);
    const expr = [...result.expressions.values()][0];
    expect(expr.expression).toBe(".Values.name");
  });

  test("preserves non-template lines", () => {
    const template = `apiVersion: v1\nkind: Service\nmetadata:\n  name: {{ .Values.name }}`;
    const result = stripTemplateExpressions(template);
    expect(result.yaml).toContain("apiVersion: v1");
    expect(result.yaml).toContain("kind: Service");
  });
});

describe("classifyExpression", () => {
  test("classifies .Values references", () => {
    expect(classifyExpression(".Values.name")).toBe("values");
    expect(classifyExpression(".Values.image.tag")).toBe("values");
  });

  test("classifies .Release references", () => {
    expect(classifyExpression(".Release.Name")).toBe("release");
  });

  test("classifies .Chart references", () => {
    expect(classifyExpression(".Chart.Name")).toBe("chart");
  });

  test("classifies include calls", () => {
    expect(classifyExpression('include "my-app.fullname" .')).toBe("include");
  });

  test("classifies toYaml calls", () => {
    expect(classifyExpression("toYaml .Values.resources | nindent 12")).toBe("toYaml");
  });

  test("classifies printf calls", () => {
    expect(classifyExpression('printf "%s:%s" .Values.image.repo .Values.image.tag')).toBe("printf");
  });

  test("classifies pipe expressions", () => {
    expect(classifyExpression(".Values.name | upper")).toBe("pipe");
  });

  test("classifies quote expressions", () => {
    expect(classifyExpression(".Values.name | quote")).toBe("quote");
  });
});

describe("HelmParser", () => {
  test("parses Chart.yaml into Helm::Chart resource", () => {
    const files = {
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
    };
    const parser = new HelmParser();
    const ir = parser.parseFiles(files);
    const chartRes = ir.resources.find((r) => r.type === "Helm::Chart");
    expect(chartRes).toBeDefined();
    expect(chartRes!.properties.name).toBe("test");
  });

  test("parses values.yaml into parameters", () => {
    const files = {
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "values.yaml": "replicaCount: 2\nimage:\n  repository: nginx\n  tag: latest\n",
    };
    const parser = new HelmParser();
    const ir = parser.parseFiles(files);
    expect(ir.parameters.length).toBeGreaterThan(0);
    const replicaParam = ir.parameters.find((p) => p.name === "replicaCount");
    expect(replicaParam).toBeDefined();
    expect(replicaParam!.defaultValue).toBe(2);
  });

  test("parses template files as K8s resources", () => {
    const files = {
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "templates/deploy.yaml": "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: test\n",
    };
    const parser = new HelmParser();
    const ir = parser.parseFiles(files);
    const deploy = ir.resources.find((r) => r.type === "K8s::Apps::Deployment");
    expect(deploy).toBeDefined();
  });

  test("parses NOTES.txt as Helm::Notes", () => {
    const files = {
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "templates/NOTES.txt": "Thank you for installing {{ .Chart.Name }}",
    };
    const parser = new HelmParser();
    const ir = parser.parseFiles(files);
    const notes = ir.resources.find((r) => r.type === "Helm::Notes");
    expect(notes).toBeDefined();
  });

  test("strips Go template expressions from templates", () => {
    const files = {
      "Chart.yaml": "apiVersion: v2\nname: test\nversion: 0.1.0\n",
      "templates/svc.yaml": "apiVersion: v1\nkind: Service\nmetadata:\n  name: {{ include \"test.fullname\" . }}\n",
    };
    const parser = new HelmParser();
    const ir = parser.parseFiles(files);
    const svc = ir.resources.find((r) => r.type === "K8s::Core::Service");
    expect(svc).toBeDefined();
    expect(svc!.metadata?.templateExpressions).toBeDefined();
  });

  test("sets chart name in metadata", () => {
    const files = {
      "Chart.yaml": "apiVersion: v2\nname: my-app\nversion: 0.1.0\n",
    };
    const parser = new HelmParser();
    const ir = parser.parseFiles(files);
    expect(ir.metadata?.chartName).toBe("my-app");
  });
});

describe("HelmGenerator", () => {
  test("generates TypeScript with Helm imports", () => {
    const ir = {
      resources: [
        { logicalId: "chart", type: "Helm::Chart", properties: { apiVersion: "v2", name: "test", version: "0.1.0" } },
        { logicalId: "valuesSchema", type: "Helm::Values", properties: { replicaCount: 1 } },
      ],
      parameters: [],
    };
    const gen = new HelmGenerator();
    const files = gen.generate(ir);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("chart.ts");
    expect(files[0].content).toContain("@intentius/chant-lexicon-helm");
    expect(files[0].content).toContain("export const chart = new Chart(");
    expect(files[0].content).toContain("export const valuesSchema = new Values(");
  });

  test("generates K8s resource imports", () => {
    const ir = {
      resources: [
        {
          logicalId: "deployment",
          type: "K8s::Apps::Deployment",
          properties: { metadata: { name: "test" } },
        },
      ],
      parameters: [],
    };
    const gen = new HelmGenerator();
    const files = gen.generate(ir);
    expect(files[0].content).toContain("@intentius/chant-lexicon-k8s");
    expect(files[0].content).toContain("export const deployment = new Deployment(");
  });

  test("substitutes template expressions with intrinsic calls", () => {
    const ir = {
      resources: [
        {
          logicalId: "service",
          type: "K8s::Core::Service",
          properties: {
            metadata: { name: "__HELM_PLACEHOLDER0__" },
          },
          metadata: {
            templateExpressions: {
              "__HELM_PLACEHOLDER0__": { expression: 'include "test.fullname" .', kind: "include" },
            },
          },
        },
      ],
      parameters: [],
    };
    const gen = new HelmGenerator();
    const files = gen.generate(ir);
    expect(files[0].content).toContain('include("test.fullname")');
  });

  test("imports intrinsics based on template expressions", () => {
    const ir = {
      resources: [
        {
          logicalId: "deploy",
          type: "K8s::Apps::Deployment",
          properties: { metadata: { name: "__HELM_PLACEHOLDER0__" }, spec: { replicas: "__HELM_PLACEHOLDER1__" } },
          metadata: {
            templateExpressions: {
              "__HELM_PLACEHOLDER0__": { expression: 'include "test.fullname" .', kind: "include" },
              "__HELM_PLACEHOLDER1__": { expression: ".Values.replicaCount", kind: "values" },
            },
          },
        },
      ],
      parameters: [],
    };
    const gen = new HelmGenerator();
    const files = gen.generate(ir);
    expect(files[0].content).toContain("include");
    expect(files[0].content).toContain("values");
  });
});
