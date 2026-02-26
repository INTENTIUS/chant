import { describe, test, expect } from "bun:test";
import { createResource, createProperty } from "@intentius/chant/runtime";
import type { Declarable } from "@intentius/chant/declarable";
import type { SerializerResult } from "@intentius/chant/serializer";
import { helmSerializer } from "./serializer";
import { Chart, Values, HelmNotes, HelmTest, HelmHook, HelmDependency } from "./resources";
import { values, include, printf, toYaml, quote, helmDefault, required, If, Range, With, Release, ChartRef } from "./intrinsics";

function makeEntities(...pairs: [string, Record<string, unknown>][]): Map<string, Declarable> {
  const entities = new Map<string, Declarable>();
  for (const [name, entity] of pairs) {
    entities.set(name, entity as unknown as Declarable);
  }
  return entities;
}

// K8s resource constructors for testing
const Deployment = createResource("K8s::Apps::Deployment", "k8s", {});
const Service = createResource("K8s::Core::Service", "k8s", {});
const ConfigMap = createResource("K8s::Core::ConfigMap", "k8s", {});
const Ingress = createResource("K8s::Networking::Ingress", "k8s", {});

describe("helmSerializer", () => {
  test("name and rulePrefix", () => {
    expect(helmSerializer.name).toBe("helm");
    expect(helmSerializer.rulePrefix).toBe("WHM");
  });

  test("returns SerializerResult with files map", () => {
    const chart = new Chart({ apiVersion: "v2", name: "test-app", version: "0.1.0" });
    const entities = makeEntities(["chart", chart]);
    const result = helmSerializer.serialize(entities) as SerializerResult;

    expect(result.primary).toBeDefined();
    expect(result.files).toBeDefined();
    expect(result.files!["Chart.yaml"]).toBeDefined();
    expect(result.files!["values.yaml"]).toBeDefined();
    expect(result.files![".helmignore"]).toBeDefined();
    expect(result.files!["templates/_helpers.tpl"]).toBeDefined();
  });

  test("emits Chart.yaml with correct fields", () => {
    const chart = new Chart({
      apiVersion: "v2",
      name: "my-app",
      version: "1.0.0",
      appVersion: "2.0.0",
      description: "My application chart",
      type: "application",
    });
    const entities = makeEntities(["chart", chart]);
    const result = helmSerializer.serialize(entities) as SerializerResult;
    const chartYaml = result.files!["Chart.yaml"];

    expect(chartYaml).toContain("apiVersion: v2");
    expect(chartYaml).toContain("name: my-app");
    expect(chartYaml).toContain("version: '1.0.0'");
    expect(chartYaml).toContain("appVersion: '2.0.0'");
    expect(chartYaml).toContain("description: My application chart");
    expect(chartYaml).toContain("type: application");
  });

  test("emits values.yaml from Values entity", () => {
    const chart = new Chart({ name: "test", version: "0.1.0" });
    const vals = new Values({
      replicaCount: 2,
      image: { repository: "nginx", tag: "latest" },
    });
    const entities = makeEntities(["chart", chart], ["values", vals]);
    const result = helmSerializer.serialize(entities) as SerializerResult;
    const valuesYaml = result.files!["values.yaml"];

    expect(valuesYaml).toContain("replicaCount: 2");
    expect(valuesYaml).toContain("image:");
    expect(valuesYaml).toContain("repository: nginx");
    expect(valuesYaml).toContain("tag: latest");
  });

  test("generates values.schema.json from Values", () => {
    const chart = new Chart({ name: "test", version: "0.1.0" });
    const vals = new Values({
      replicaCount: 2,
      enabled: true,
      name: "test",
    });
    const entities = makeEntities(["chart", chart], ["values", vals]);
    const result = helmSerializer.serialize(entities) as SerializerResult;
    const schema = JSON.parse(result.files!["values.schema.json"]);

    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.type).toBe("object");
    expect(schema.properties.replicaCount.type).toBe("integer");
    expect(schema.properties.replicaCount.default).toBe(2);
    expect(schema.properties.enabled.type).toBe("boolean");
    expect(schema.properties.enabled.default).toBe(true);
    expect(schema.properties.name.type).toBe("string");
    expect(schema.properties.name.default).toBe("test");
  });

  test("emits _helpers.tpl with chart name", () => {
    const chart = new Chart({ name: "my-app", version: "0.1.0" });
    const entities = makeEntities(["chart", chart]);
    const result = helmSerializer.serialize(entities) as SerializerResult;
    const helpers = result.files!["templates/_helpers.tpl"];

    expect(helpers).toContain('define "my-app.name"');
    expect(helpers).toContain('define "my-app.fullname"');
    expect(helpers).toContain('define "my-app.labels"');
    expect(helpers).toContain('define "my-app.selectorLabels"');
    expect(helpers).toContain('define "my-app.chart"');
  });

  test("emits K8s Deployment as template with Go template expressions", () => {
    const chart = new Chart({ name: "my-app", version: "0.1.0" });
    const vals = new Values({ replicaCount: 1 });
    const deployment = new Deployment({
      metadata: {
        name: include("my-app.fullname"),
        labels: include("my-app.labels"),
      },
      spec: {
        replicas: values.replicaCount,
        template: {
          spec: {
            containers: [{
              name: "app",
              image: printf("%s:%s", values.image.repository, values.image.tag),
            }],
          },
        },
      },
    });

    const entities = makeEntities(
      ["chart", chart],
      ["values", vals],
      ["webDeployment", deployment],
    );
    const result = helmSerializer.serialize(entities) as SerializerResult;
    const template = result.files!["templates/web-deployment.yaml"];

    expect(template).toBeDefined();
    expect(template).toContain("apiVersion: apps/v1");
    expect(template).toContain("kind: Deployment");
    expect(template).toContain('{{ include "my-app.fullname" . }}');
    expect(template).toContain("{{ .Values.replicaCount }}");
    expect(template).toContain('{{ printf "%s:%s" .Values.image.repository .Values.image.tag }}');
  });

  test("emits K8s Service template", () => {
    const chart = new Chart({ name: "test", version: "0.1.0" });
    const svc = new Service({
      metadata: { name: include("test.fullname") },
      spec: {
        type: values.service.type,
        ports: [{
          port: values.service.port,
          targetPort: "http",
        }],
      },
    });

    const entities = makeEntities(["chart", chart], ["appService", svc]);
    const result = helmSerializer.serialize(entities) as SerializerResult;
    const template = result.files!["templates/app-service.yaml"];

    expect(template).toBeDefined();
    expect(template).toContain("apiVersion: v1");
    expect(template).toContain("kind: Service");
    expect(template).toContain("{{ .Values.service.type }}");
    expect(template).toContain("{{ .Values.service.port }}");
  });

  test("emits ConfigMap as specless K8s resource", () => {
    const chart = new Chart({ name: "test", version: "0.1.0" });
    const cm = new ConfigMap({
      metadata: { name: "my-config" },
      data: { key: "value" },
    });

    const entities = makeEntities(["chart", chart], ["config", cm]);
    const result = helmSerializer.serialize(entities) as SerializerResult;
    const template = result.files!["templates/config.yaml"];

    expect(template).toBeDefined();
    expect(template).toContain("apiVersion: v1");
    expect(template).toContain("kind: ConfigMap");
    expect(template).toContain("data:");
    expect(template).toContain("key: value");
    // ConfigMap should NOT have spec wrapper
    expect(template).not.toContain("spec:");
  });

  test("emits NOTES.txt from HelmNotes entity", () => {
    const chart = new Chart({ name: "test", version: "0.1.0" });
    const notes = new HelmNotes({
      content: "Thank you for installing {{ .Chart.Name }}.\nRelease: {{ .Release.Name }}",
    });

    const entities = makeEntities(["chart", chart], ["notes", notes]);
    const result = helmSerializer.serialize(entities) as SerializerResult;

    expect(result.files!["templates/NOTES.txt"]).toBe(
      "Thank you for installing {{ .Chart.Name }}.\nRelease: {{ .Release.Name }}",
    );
  });

  test("defaults Chart.yaml fields when not provided", () => {
    const chart = new Chart({});
    const entities = makeEntities(["chart", chart]);
    const result = helmSerializer.serialize(entities) as SerializerResult;
    const chartYaml = result.files!["Chart.yaml"];

    expect(chartYaml).toContain("apiVersion: v2");
    expect(chartYaml).toContain("type: application");
    expect(chartYaml).toContain("version:");
  });

  test("emits empty values.yaml when no Values entity", () => {
    const chart = new Chart({ name: "test", version: "0.1.0" });
    const entities = makeEntities(["chart", chart]);
    const result = helmSerializer.serialize(entities) as SerializerResult;

    expect(result.files!["values.yaml"]).toBe("{}\n");
  });

  test("does not emit values.schema.json when no Values entity", () => {
    const chart = new Chart({ name: "test", version: "0.1.0" });
    const entities = makeEntities(["chart", chart]);
    const result = helmSerializer.serialize(entities) as SerializerResult;

    expect(result.files!["values.schema.json"]).toBeUndefined();
  });

  test("toYaml intrinsic emits raw expression in template", () => {
    const chart = new Chart({ name: "test", version: "0.1.0" });
    const vals = new Values({ resources: {} });
    const deployment = new Deployment({
      metadata: { name: "test" },
      spec: {
        template: {
          spec: {
            containers: [{
              name: "app",
              resources: toYaml(values.resources, 12),
            }],
          },
        },
      },
    });

    const entities = makeEntities(
      ["chart", chart],
      ["values", vals],
      ["deployment", deployment],
    );
    const result = helmSerializer.serialize(entities) as SerializerResult;
    const template = result.files!["templates/deployment.yaml"];

    expect(template).toContain("{{ toYaml .Values.resources | nindent 12 }}");
  });

  test("Release intrinsic emits in template", () => {
    const chart = new Chart({ name: "test", version: "0.1.0" });
    const cm = new ConfigMap({
      metadata: { name: Release.Name },
      data: { namespace: Release.Namespace },
    });

    const entities = makeEntities(["chart", chart], ["config", cm]);
    const result = helmSerializer.serialize(entities) as SerializerResult;
    const template = result.files!["templates/config.yaml"];

    expect(template).toContain("{{ .Release.Name }}");
    expect(template).toContain("{{ .Release.Namespace }}");
  });

  test("multiple K8s resources emit as separate template files", () => {
    const chart = new Chart({ name: "test", version: "0.1.0" });
    const deploy = new Deployment({
      metadata: { name: "app" },
      spec: { replicas: 1 },
    });
    const svc = new Service({
      metadata: { name: "app" },
      spec: { type: "ClusterIP" },
    });

    const entities = makeEntities(
      ["chart", chart],
      ["appDeployment", deploy],
      ["appService", svc],
    );
    const result = helmSerializer.serialize(entities) as SerializerResult;

    expect(result.files!["templates/app-deployment.yaml"]).toBeDefined();
    expect(result.files!["templates/app-service.yaml"]).toBeDefined();
  });
});

// ── Phase 2 tests ─────────────────────────────────────────

describe("resource-level If", () => {
  test("wraps entire template in {{- if }} / {{- end }}", () => {
    const chart = new Chart({ name: "test", version: "0.1.0" });
    const ingress = If(
      values.ingress.enabled,
      new Ingress({
        metadata: { name: include("test.fullname") },
        spec: {
          rules: [{ host: values.ingress.host }],
        },
      }),
    );

    const entities = makeEntities(["chart", chart], ["ingress", ingress as any]);
    const result = helmSerializer.serialize(entities) as SerializerResult;
    const template = result.files!["templates/ingress.yaml"];

    expect(template).toBeDefined();
    expect(template).toStartWith("{{- if .Values.ingress.enabled }}\n");
    expect(template).toContain("apiVersion: networking.k8s.io/v1");
    expect(template).toContain("kind: Ingress");
    expect(template).toContain('{{ include "test.fullname" . }}');
    expect(template).toContain("{{ .Values.ingress.host }}");
    expect(template.trimEnd()).toEndWith("{{- end }}");
  });

  test("does not wrap non-conditional resources", () => {
    const chart = new Chart({ name: "test", version: "0.1.0" });
    const svc = new Service({ metadata: { name: "app" }, spec: { type: "ClusterIP" } });
    const entities = makeEntities(["chart", chart], ["svc", svc]);
    const result = helmSerializer.serialize(entities) as SerializerResult;
    const template = result.files!["templates/svc.yaml"];

    expect(template).not.toContain("{{- if");
    expect(template).not.toContain("{{- end }}");
  });
});

describe("HelmHook serialization", () => {
  test("emits hook annotations on wrapped resource", () => {
    const chart = new Chart({ name: "test", version: "0.1.0" });
    const Job = createResource("K8s::Batch::Job", "k8s", {});
    const hook = new HelmHook({
      hook: "pre-install",
      weight: -5,
      deletePolicy: "before-hook-creation",
      resource: new Job({
        metadata: { name: "db-migrate" },
        spec: {
          template: {
            spec: {
              containers: [{ name: "migrate", image: "migrate:latest" }],
              restartPolicy: "Never",
            },
          },
        },
      }),
    });

    const entities = makeEntities(["chart", chart], ["dbMigrate", hook]);
    const result = helmSerializer.serialize(entities) as SerializerResult;
    const template = result.files!["templates/db-migrate.yaml"];

    expect(template).toBeDefined();
    expect(template).toContain("apiVersion: batch/v1");
    expect(template).toContain("kind: Job");
    expect(template).toContain("helm.sh/hook: pre-install");
    expect(template).toContain("helm.sh/hook-weight: -5");
    expect(template).toContain("helm.sh/hook-delete-policy: before-hook-creation");
  });
});

describe("HelmTest serialization", () => {
  test("emits test pod with helm.sh/hook: test annotation", () => {
    const chart = new Chart({ name: "test", version: "0.1.0" });
    const Pod = createResource("K8s::Core::Pod", "k8s", {});
    const testPod = new HelmTest({
      resource: new Pod({
        metadata: { name: "test-connection" },
        spec: {
          containers: [{
            name: "wget",
            image: "busybox",
            command: ["wget", "--spider", "http://test:80"],
          }],
          restartPolicy: "Never",
        },
      }),
    });

    const entities = makeEntities(["chart", chart], ["testConnection", testPod]);
    const result = helmSerializer.serialize(entities) as SerializerResult;
    const template = result.files!["templates/tests/test-connection.yaml"];

    expect(template).toBeDefined();
    expect(template).toContain("apiVersion: v1");
    expect(template).toContain("kind: Pod");
    expect(template).toContain("helm.sh/hook: test");
    expect(template).toContain("image: busybox");
  });
});

describe("HelmDependency serialization", () => {
  test("emits dependencies in Chart.yaml", () => {
    const chart = new Chart({ name: "my-app", version: "1.0.0" });
    const redisDep = new HelmDependency({
      name: "redis",
      version: "17.x.x",
      repository: "https://charts.bitnami.com/bitnami",
      condition: "redis.enabled",
    });
    const pgDep = new HelmDependency({
      name: "postgresql",
      version: "12.x.x",
      repository: "https://charts.bitnami.com/bitnami",
      alias: "db",
    });

    const entities = makeEntities(
      ["chart", chart],
      ["redisDep", redisDep],
      ["pgDep", pgDep],
    );
    const result = helmSerializer.serialize(entities) as SerializerResult;
    const chartYaml = result.files!["Chart.yaml"];

    expect(chartYaml).toContain("dependencies:");
    expect(chartYaml).toContain("name: redis");
    expect(chartYaml).toContain("version: '17.x.x'");
    expect(chartYaml).toContain("repository: https://charts.bitnami.com/bitnami");
    expect(chartYaml).toContain("condition: redis.enabled");
    expect(chartYaml).toContain("name: postgresql");
    expect(chartYaml).toContain("alias: db");
  });
});

describe("values.schema.json nested types", () => {
  test("infers nested object properties", () => {
    const chart = new Chart({ name: "test", version: "0.1.0" });
    const vals = new Values({
      image: {
        repository: "nginx",
        tag: "latest",
        pullPolicy: "IfNotPresent",
      },
    });
    const entities = makeEntities(["chart", chart], ["values", vals]);
    const result = helmSerializer.serialize(entities) as SerializerResult;
    const schema = JSON.parse(result.files!["values.schema.json"]);

    expect(schema.properties.image.type).toBe("object");
    expect(schema.properties.image.properties.repository.type).toBe("string");
    expect(schema.properties.image.properties.repository.default).toBe("nginx");
    expect(schema.properties.image.properties.tag.type).toBe("string");
    expect(schema.properties.image.properties.pullPolicy.type).toBe("string");
  });

  test("infers array types with items", () => {
    const chart = new Chart({ name: "test", version: "0.1.0" });
    const vals = new Values({
      hosts: ["example.com"],
      ports: [80, 443],
    });
    const entities = makeEntities(["chart", chart], ["values", vals]);
    const result = helmSerializer.serialize(entities) as SerializerResult;
    const schema = JSON.parse(result.files!["values.schema.json"]);

    expect(schema.properties.hosts.type).toBe("array");
    expect(schema.properties.hosts.items.type).toBe("string");
    expect(schema.properties.ports.type).toBe("array");
    expect(schema.properties.ports.items.type).toBe("integer");
  });

  test("includes required fields for non-empty defaults", () => {
    const chart = new Chart({ name: "test", version: "0.1.0" });
    const vals = new Values({
      image: {
        repository: "nginx",
        tag: "",
        pullPolicy: "IfNotPresent",
      },
    });
    const entities = makeEntities(["chart", chart], ["values", vals]);
    const result = helmSerializer.serialize(entities) as SerializerResult;
    const schema = JSON.parse(result.files!["values.schema.json"]);

    // tag is empty string, so not required; repository and pullPolicy are
    expect(schema.properties.image.required).toContain("repository");
    expect(schema.properties.image.required).toContain("pullPolicy");
    expect(schema.properties.image.required).not.toContain("tag");
  });

  test("handles float numbers", () => {
    const chart = new Chart({ name: "test", version: "0.1.0" });
    const vals = new Values({ cpuLimit: 0.5 });
    const entities = makeEntities(["chart", chart], ["values", vals]);
    const result = helmSerializer.serialize(entities) as SerializerResult;
    const schema = JSON.parse(result.files!["values.schema.json"]);

    expect(schema.properties.cpuLimit.type).toBe("number");
    expect(schema.properties.cpuLimit.default).toBe(0.5);
  });
});

describe("template function expressions in templates", () => {
  test("quote function in template", () => {
    const chart = new Chart({ name: "test", version: "0.1.0" });
    const cm = new ConfigMap({
      metadata: { name: "config" },
      data: { version: quote(values.appVersion) },
    });

    const entities = makeEntities(["chart", chart], ["config", cm]);
    const result = helmSerializer.serialize(entities) as SerializerResult;
    const template = result.files!["templates/config.yaml"];

    expect(template).toContain("{{ .Values.appVersion | quote }}");
  });

  test("helmDefault function in template", () => {
    const chart = new Chart({ name: "test", version: "0.1.0" });
    const deploy = new Deployment({
      metadata: { name: "app" },
      spec: {
        replicas: helmDefault(1, values.replicaCount),
      },
    });

    const entities = makeEntities(["chart", chart], ["deploy", deploy]);
    const result = helmSerializer.serialize(entities) as SerializerResult;
    const template = result.files!["templates/deploy.yaml"];

    expect(template).toContain('{{ default 1 .Values.replicaCount }}');
  });

  test("required function in template", () => {
    const chart = new Chart({ name: "test", version: "0.1.0" });
    const deploy = new Deployment({
      metadata: { name: "app" },
      spec: {
        template: {
          spec: {
            containers: [{
              name: "app",
              image: required("image.tag is required", values.image.tag),
            }],
          },
        },
      },
    });

    const entities = makeEntities(["chart", chart], ["deploy", deploy]);
    const result = helmSerializer.serialize(entities) as SerializerResult;
    const template = result.files!["templates/deploy.yaml"];

    expect(template).toContain('{{ required "image.tag is required" .Values.image.tag }}');
  });

  test("ChartRef in template", () => {
    const chart = new Chart({ name: "test", version: "0.1.0" });
    const cm = new ConfigMap({
      metadata: { name: "meta" },
      data: {
        chartName: ChartRef.Name,
        chartVersion: ChartRef.Version,
      },
    });

    const entities = makeEntities(["chart", chart], ["meta", cm]);
    const result = helmSerializer.serialize(entities) as SerializerResult;
    const template = result.files!["templates/meta.yaml"];

    expect(template).toContain("{{ .Chart.Name }}");
    expect(template).toContain("{{ .Chart.Version }}");
  });
});

describe("pipe chaining in values proxy", () => {
  test("values.x.pipe('upper').pipe('quote') emits correct expression", () => {
    const chart = new Chart({ name: "test", version: "0.1.0" });
    const cm = new ConfigMap({
      metadata: { name: "config" },
      data: { env: (values.environment as any).pipe("upper").pipe("quote") },
    });

    const entities = makeEntities(["chart", chart], ["config", cm]);
    const result = helmSerializer.serialize(entities) as SerializerResult;
    const template = result.files!["templates/config.yaml"];

    expect(template).toContain("{{ .Values.environment | upper | quote }}");
  });
});

describe("helpers", () => {
  test("generateHelpers includes all standard templates", () => {
    const { generateHelpers } = require("./helpers");
    const content = generateHelpers({ chartName: "my-chart" });

    expect(content).toContain('define "my-chart.name"');
    expect(content).toContain('define "my-chart.fullname"');
    expect(content).toContain('define "my-chart.chart"');
    expect(content).toContain('define "my-chart.labels"');
    expect(content).toContain('define "my-chart.selectorLabels"');
    expect(content).toContain('define "my-chart.serviceAccountName"');
  });

  test("generateHelpers respects includeServiceAccount=false", () => {
    const { generateHelpers } = require("./helpers");
    const content = generateHelpers({ chartName: "test", includeServiceAccount: false });

    expect(content).toContain('define "test.name"');
    expect(content).not.toContain("serviceAccountName");
  });
});
