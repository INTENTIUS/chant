import { describe, test, expect } from "bun:test";
import { k8sSerializer } from "./serializer";
import { DECLARABLE_MARKER } from "@intentius/chant/declarable";
import {
  defaultLabels,
  defaultAnnotations,
  DEFAULT_LABELS_MARKER,
  DEFAULT_ANNOTATIONS_MARKER,
} from "./default-labels";

// ── Mock helpers ────────────────────────────────────────────────────

function mockResource(
  entityType: string,
  props: Record<string, unknown>,
): any {
  return {
    [DECLARABLE_MARKER]: true,
    lexicon: "k8s",
    entityType,
    kind: "resource",
    props,
  };
}

function mockProperty(
  entityType: string,
  props: Record<string, unknown>,
): any {
  return {
    [DECLARABLE_MARKER]: true,
    lexicon: "k8s",
    entityType,
    kind: "property",
    props,
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe("k8sSerializer", () => {
  test("name is k8s", () => {
    expect(k8sSerializer.name).toBe("k8s");
  });

  test("rulePrefix is WK8", () => {
    expect(k8sSerializer.rulePrefix).toBe("WK8");
  });

  test("empty entities produce empty string", () => {
    const result = k8sSerializer.serialize(new Map());
    expect(result).toBe("");
  });

  test("single Deployment produces valid YAML with apiVersion/kind/metadata/spec", () => {
    const entities = new Map<string, any>();
    entities.set(
      "myApp",
      mockResource("K8s::Apps::Deployment", {
        metadata: { name: "my-app", labels: { app: "my-app" } },
        spec: { replicas: 2 },
      }),
    );

    const result = k8sSerializer.serialize(entities);
    expect(result).toContain("apiVersion:");
    expect(result).toContain("kind: Deployment");
    expect(result).toContain("name: my-app");
    expect(result).toContain("replicas: 2");
  });

  test("metadata.name auto-generated from logical name (camelCase→kebab-case)", () => {
    const entities = new Map<string, any>();
    entities.set(
      "myWebApp",
      mockResource("K8s::Apps::Deployment", {
        spec: { replicas: 1 },
      }),
    );

    const result = k8sSerializer.serialize(entities);
    expect(result).toContain("name: my-web-app");
  });

  test("explicit metadata.name preserved", () => {
    const entities = new Map<string, any>();
    entities.set(
      "myApp",
      mockResource("K8s::Apps::Deployment", {
        metadata: { name: "custom-name" },
        spec: { replicas: 1 },
      }),
    );

    const result = k8sSerializer.serialize(entities);
    expect(result).toContain("name: custom-name");
  });

  test("ConfigMap uses top-level data (specless type)", () => {
    const entities = new Map<string, any>();
    entities.set(
      "config",
      mockResource("K8s::Core::ConfigMap", {
        metadata: { name: "app-config" },
        data: { DB_HOST: "localhost" },
      }),
    );

    const result = k8sSerializer.serialize(entities);
    expect(result).toContain("kind: ConfigMap");
    expect(result).toContain("DB_HOST: localhost");
    expect(result).not.toContain("spec:");
  });

  test("Secret uses top-level stringData (specless type)", () => {
    const entities = new Map<string, any>();
    entities.set(
      "secret",
      mockResource("K8s::Core::Secret", {
        metadata: { name: "app-secret" },
        stringData: { API_KEY: "secret123" },
      }),
    );

    const result = k8sSerializer.serialize(entities);
    expect(result).toContain("kind: Secret");
    expect(result).toContain("API_KEY: secret123");
    expect(result).not.toContain("spec:");
  });

  test("Namespace is specless type", () => {
    const entities = new Map<string, any>();
    entities.set(
      "myNs",
      mockResource("K8s::Core::Namespace", {
        metadata: { name: "my-namespace" },
      }),
    );

    const result = k8sSerializer.serialize(entities);
    expect(result).toContain("kind: Namespace");
    expect(result).toContain("name: my-namespace");
    expect(result).not.toContain("spec:");
  });

  test("multi-resource entities joined by ---", () => {
    const entities = new Map<string, any>();
    entities.set(
      "deploy",
      mockResource("K8s::Apps::Deployment", {
        metadata: { name: "app" },
        spec: { replicas: 1 },
      }),
    );
    entities.set(
      "svc",
      mockResource("K8s::Core::Service", {
        metadata: { name: "app" },
        spec: { ports: [{ port: 80 }] },
      }),
    );

    const result = k8sSerializer.serialize(entities);
    expect(result).toContain("---");
    expect(result).toContain("kind: Deployment");
    expect(result).toContain("kind: Service");
  });

  test("default labels merged into metadata.labels", () => {
    const entities = new Map<string, any>();
    entities.set("labels", defaultLabels({ env: "prod" }));
    entities.set(
      "deploy",
      mockResource("K8s::Apps::Deployment", {
        metadata: { name: "app" },
        spec: { replicas: 1 },
      }),
    );

    const result = k8sSerializer.serialize(entities);
    expect(result).toContain("env: prod");
  });

  test("default annotations merged into metadata.annotations", () => {
    const entities = new Map<string, any>();
    entities.set("annot", defaultAnnotations({ "note": "hello" }));
    entities.set(
      "deploy",
      mockResource("K8s::Apps::Deployment", {
        metadata: { name: "app" },
        spec: { replicas: 1 },
      }),
    );

    const result = k8sSerializer.serialize(entities);
    expect(result).toContain("note: hello");
  });

  test("explicit labels override default labels", () => {
    const entities = new Map<string, any>();
    entities.set("labels", defaultLabels({ env: "dev" }));
    entities.set(
      "deploy",
      mockResource("K8s::Apps::Deployment", {
        metadata: { name: "app", labels: { env: "prod" } },
        spec: { replicas: 1 },
      }),
    );

    const result = k8sSerializer.serialize(entities);
    expect(result).toContain("env: prod");
    // Should not contain "dev" since explicit overrides
    const envLines = result.split("\n").filter((l: string) => l.includes("env:"));
    expect(envLines.every((l: string) => !l.includes("dev"))).toBe(true);
  });

  test("property entities skipped in output", () => {
    const entities = new Map<string, any>();
    entities.set("container", mockProperty("K8s::Core::Container", { name: "app" }));
    entities.set(
      "deploy",
      mockResource("K8s::Apps::Deployment", {
        metadata: { name: "app" },
        spec: { replicas: 1 },
      }),
    );

    const result = k8sSerializer.serialize(entities);
    expect(result).toContain("kind: Deployment");
    // Only one document — property entities should not appear as separate docs
    expect(result.split("---").length).toBeLessThanOrEqual(2);
  });

  test("DefaultLabels entities skipped in output", () => {
    const entities = new Map<string, any>();
    entities.set("labels", defaultLabels({ env: "prod" }));

    const result = k8sSerializer.serialize(entities);
    // defaultLabels alone should not produce any output
    expect(result).toBe("");
  });

  test("DefaultAnnotations entities skipped in output", () => {
    const entities = new Map<string, any>();
    entities.set("annotations", defaultAnnotations({ note: "hi" }));

    const result = k8sSerializer.serialize(entities);
    expect(result).toBe("");
  });

  test("key ordering: apiVersion, kind, metadata, spec, then rest", () => {
    const entities = new Map<string, any>();
    entities.set(
      "deploy",
      mockResource("K8s::Apps::Deployment", {
        metadata: { name: "app" },
        spec: { replicas: 1 },
      }),
    );

    const result = k8sSerializer.serialize(entities);
    const lines = result.split("\n");
    const keyLines = lines.filter((l: string) => /^\w+:/.test(l));
    const keys = keyLines.map((l: string) => l.split(":")[0]);

    const apiIdx = keys.indexOf("apiVersion");
    const kindIdx = keys.indexOf("kind");
    const metaIdx = keys.indexOf("metadata");
    const specIdx = keys.indexOf("spec");

    expect(apiIdx).toBeLessThan(kindIdx);
    expect(kindIdx).toBeLessThan(metaIdx);
    expect(metaIdx).toBeLessThan(specIdx);
  });
});
