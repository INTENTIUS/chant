import { describe, test, expect } from "vitest";
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

  test("ClusterRole is specless type", () => {
    const entities = new Map<string, any>();
    entities.set(
      "viewRole",
      mockResource("K8s::Rbac::ClusterRole", {
        metadata: { name: "view-role" },
        rules: [{ apiGroups: [""], resources: ["pods"], verbs: ["get", "list"] }],
      }),
    );

    const result = k8sSerializer.serialize(entities);
    expect(result).toContain("kind: ClusterRole");
    expect(result).toContain("name: view-role");
    expect(result).not.toContain("spec:");
  });

  test("ClusterRoleBinding is specless type", () => {
    const entities = new Map<string, any>();
    entities.set(
      "viewBinding",
      mockResource("K8s::Rbac::ClusterRoleBinding", {
        metadata: { name: "view-binding" },
        roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: "view-role" },
        subjects: [{ kind: "ServiceAccount", name: "default", namespace: "default" }],
      }),
    );

    const result = k8sSerializer.serialize(entities);
    expect(result).toContain("kind: ClusterRoleBinding");
    expect(result).not.toContain("spec:");
  });

  test("StorageClass is specless type", () => {
    const entities = new Map<string, any>();
    entities.set(
      "gp3",
      mockResource("K8s::Storage::StorageClass", {
        metadata: { name: "gp3-encrypted" },
        provisioner: "ebs.csi.aws.com",
        parameters: { type: "gp3", encrypted: "true" },
        reclaimPolicy: "Delete",
        volumeBindingMode: "WaitForFirstConsumer",
      }),
    );

    const result = k8sSerializer.serialize(entities);
    expect(result).toContain("kind: StorageClass");
    expect(result).toContain("provisioner: ebs.csi.aws.com");
    expect(result).not.toContain("spec:");
  });

  test("APIService is specless type", () => {
    const entities = new Map<string, any>();
    entities.set(
      "metricsApi",
      mockResource("K8s::Admissionregistration::APIService", {
        metadata: { name: "v1beta1.metrics.k8s.io" },
        group: "metrics.k8s.io",
        version: "v1beta1",
        service: { name: "metrics-server", namespace: "kube-system" },
        groupPriorityMinimum: 100,
        versionPriority: 100,
      }),
    );

    const result = k8sSerializer.serialize(entities);
    expect(result).toContain("kind: APIService");
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

  test("Namespaces appear before other resources regardless of insertion order", () => {
    const entities = new Map<string, any>();
    // Insert Deployment first, then Namespace — Namespace should still come first in output
    entities.set(
      "deploy",
      mockResource("K8s::Apps::Deployment", {
        metadata: { name: "app", namespace: "my-ns" },
        spec: { replicas: 1 },
      }),
    );
    entities.set(
      "ns",
      mockResource("K8s::Core::Namespace", {
        metadata: { name: "my-ns" },
      }),
    );

    const result = k8sSerializer.serialize(entities);
    const docs = result.split("---");
    // First document should be the Namespace
    expect(docs[0]).toContain("kind: Namespace");
    expect(docs[0]).toContain("name: my-ns");
    // Second document should be the Deployment
    expect(docs[1]).toContain("kind: Deployment");
  });

  test("ConfigMap multiline data emits as | block scalar", () => {
    const entities = new Map<string, any>();
    const multilineConfig = "[SERVICE]\n    Flush 5\n    Log_Level info\n\n[INPUT]\n    Name tail\n";
    entities.set(
      "config",
      mockResource("K8s::Core::ConfigMap", {
        metadata: { name: "app-config" },
        data: { "fluent-bit.conf": multilineConfig },
      }),
    );

    const result = k8sSerializer.serialize(entities);
    expect(result).toContain("kind: ConfigMap");
    // Must use | block scalar, not flatten to single line
    expect(result).toContain("fluent-bit.conf: |");
    // Content lines should be preserved (indented under the key)
    expect(result).toContain("[SERVICE]");
    expect(result).toContain("Flush 5");
    expect(result).toContain("[INPUT]");
    expect(result).toContain("Name tail");
    // Should NOT contain literal \n in the output
    expect(result).not.toContain("\\n");
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
