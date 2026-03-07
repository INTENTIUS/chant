import { describe, test, expect } from "bun:test";
import { HelmParser } from "./parser";
import { HelmGenerator } from "./generator";

const parser = new HelmParser();
const generator = new HelmGenerator();

describe("roundtrip: parse -> generate", () => {
  test("minimal chart roundtrip", () => {
    const files = {
      "Chart.yaml": "apiVersion: v2\nname: my-app\nversion: 0.1.0\n",
    };
    const ir = parser.parseFiles(files);
    const generated = generator.generate(ir);

    expect(generated).toHaveLength(1);
    expect(generated[0].path).toBe("chart.ts");
    expect(generated[0].content).toContain("import");
    expect(generated[0].content).toContain("export const chart = new Chart(");
  });

  test("chart with values roundtrip", () => {
    const files = {
      "Chart.yaml": "apiVersion: v2\nname: my-app\nversion: 0.1.0\n",
      "values.yaml": "replicaCount: 2\nimage:\n  repository: nginx\n  tag: latest\n",
    };
    const ir = parser.parseFiles(files);
    expect(ir.parameters.length).toBeGreaterThan(0);

    const generated = generator.generate(ir);
    const content = generated[0].content;
    expect(content).toContain("Chart");
    expect(content).toContain("Values");
    expect(content).toContain("export const valuesSchema = new Values(");
  });

  test("Deployment template roundtrip", () => {
    const files = {
      "Chart.yaml": "apiVersion: v2\nname: my-app\nversion: 0.1.0\n",
      "templates/deploy.yaml": "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: my-app\nspec:\n  replicas: 1\n",
    };
    const ir = parser.parseFiles(files);
    const deploy = ir.resources.find((r) => r.type === "K8s::Apps::Deployment");
    expect(deploy).toBeDefined();

    const generated = generator.generate(ir);
    const content = generated[0].content;
    expect(content).toContain("@intentius/chant-lexicon-k8s");
    expect(content).toContain("Deployment");
    expect(content).toContain("export const");
  });

  test("Service template roundtrip", () => {
    const files = {
      "Chart.yaml": "apiVersion: v2\nname: my-app\nversion: 0.1.0\n",
      "templates/svc.yaml": "apiVersion: v1\nkind: Service\nmetadata:\n  name: my-app\nspec:\n  type: ClusterIP\n  ports:\n    - port: 80\n",
    };
    const ir = parser.parseFiles(files);
    const svc = ir.resources.find((r) => r.type === "K8s::Core::Service");
    expect(svc).toBeDefined();

    const generated = generator.generate(ir);
    const content = generated[0].content;
    expect(content).toContain("Service");
  });

  test("template expressions produce intrinsic imports", () => {
    const files = {
      "Chart.yaml": "apiVersion: v2\nname: my-app\nversion: 0.1.0\n",
      "templates/deploy.yaml": 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: {{ include "my-app.fullname" . }}\nspec:\n  replicas: {{ .Values.replicaCount }}\n',
    };
    const ir = parser.parseFiles(files);
    const generated = generator.generate(ir);
    const content = generated[0].content;
    expect(content).toContain("include");
    expect(content).toContain("values");
  });

  test("NOTES.txt roundtrip", () => {
    const files = {
      "Chart.yaml": "apiVersion: v2\nname: my-app\nversion: 0.1.0\n",
      "templates/NOTES.txt": "Thank you for installing {{ .Chart.Name }}",
    };
    const ir = parser.parseFiles(files);
    const notes = ir.resources.find((r) => r.type === "Helm::Notes");
    expect(notes).toBeDefined();

    const generated = generator.generate(ir);
    expect(generated[0].content).toContain("HelmNotes");
  });

  test("full chart with multiple resources roundtrip", () => {
    const files = {
      "Chart.yaml": "apiVersion: v2\nname: my-app\nversion: 0.1.0\n",
      "values.yaml": "replicaCount: 1\nimage:\n  repository: nginx\n  tag: stable\n",
      "templates/deploy.yaml": "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: my-app\nspec:\n  replicas: {{ .Values.replicaCount }}\n",
      "templates/svc.yaml": "apiVersion: v1\nkind: Service\nmetadata:\n  name: my-app\nspec:\n  type: ClusterIP\n",
      "templates/NOTES.txt": "Thank you for installing my-app!",
    };
    const ir = parser.parseFiles(files);
    expect(ir.resources.length).toBeGreaterThanOrEqual(4);

    const generated = generator.generate(ir);
    const content = generated[0].content;
    expect(content).toContain("Chart");
    expect(content).toContain("Values");
    expect(content).toContain("Deployment");
    expect(content).toContain("Service");
    expect(content).toContain("HelmNotes");
    expect(content).toContain("export const");
  });

  test("IR metadata captures chart name", () => {
    const files = {
      "Chart.yaml": "apiVersion: v2\nname: cool-app\nversion: 1.0.0\n",
    };
    const ir = parser.parseFiles(files);
    expect(ir.metadata?.chartName).toBe("cool-app");
  });

  test("ConfigMap template roundtrip", () => {
    const files = {
      "Chart.yaml": "apiVersion: v2\nname: my-app\nversion: 0.1.0\n",
      "templates/configmap.yaml": "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: my-config\ndata:\n  key: value\n",
    };
    const ir = parser.parseFiles(files);
    const cm = ir.resources.find((r) => r.type === "K8s::Core::ConfigMap");
    expect(cm).toBeDefined();

    const generated = generator.generate(ir);
    expect(generated[0].content).toContain("ConfigMap");
  });

  test("skips _helpers.tpl files", () => {
    const files = {
      "Chart.yaml": "apiVersion: v2\nname: my-app\nversion: 0.1.0\n",
      "templates/_helpers.tpl": '{{- define "my-app.fullname" -}}\n{{ .Release.Name }}\n{{- end -}}\n',
    };
    const ir = parser.parseFiles(files);
    // Only the chart resource, no template from _helpers.tpl
    expect(ir.resources).toHaveLength(1);
    expect(ir.resources[0].type).toBe("Helm::Chart");
  });
});
