import { describe, expect, test } from "vitest";
import { stripServerFields, buildExportFromObjects } from "./live-export";
import { K8sGenerator } from "./generator";

// A live object as `kubectl get -o json` would return it — full of
// server-written fields the user never authored.
const liveDeployment = () => ({
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: {
    name: "web",
    namespace: "default",
    uid: "abc-123",
    resourceVersion: "9981",
    generation: 4,
    creationTimestamp: "2026-01-01T00:00:00Z",
    managedFields: [{ manager: "kubectl", operation: "Apply" }],
    annotations: {
      "kubectl.kubernetes.io/last-applied-configuration": "{...}",
      "team": "platform",
    },
    labels: { app: "web" },
  },
  spec: { replicas: 3, selector: { matchLabels: { app: "web" } } },
  status: { readyReplicas: 3, replicas: 3 },
});

const liveService = () => ({
  apiVersion: "v1",
  kind: "Service",
  metadata: { name: "web", namespace: "default", uid: "svc-1", resourceVersion: "12" },
  spec: { ports: [{ port: 80 }], clusterIP: "10.0.0.1" },
  status: { loadBalancer: {} },
});

describe("stripServerFields (#116)", () => {
  test("removes status, managedFields, and server metadata", () => {
    const cleaned = stripServerFields(liveDeployment());
    expect(cleaned.status).toBeUndefined();
    const md = cleaned.metadata as Record<string, unknown>;
    expect(md.managedFields).toBeUndefined();
    expect(md.uid).toBeUndefined();
    expect(md.resourceVersion).toBeUndefined();
    expect(md.generation).toBeUndefined();
    expect(md.creationTimestamp).toBeUndefined();
  });

  test("drops server annotations but keeps authored ones", () => {
    const cleaned = stripServerFields(liveDeployment());
    const annotations = (cleaned.metadata as Record<string, unknown>).annotations as Record<string, string>;
    expect(annotations["kubectl.kubernetes.io/last-applied-configuration"]).toBeUndefined();
    expect(annotations.team).toBe("platform");
  });

  test("keeps authored spec and labels", () => {
    const cleaned = stripServerFields(liveDeployment());
    expect(cleaned.spec).toEqual({ replicas: 3, selector: { matchLabels: { app: "web" } } });
    expect((cleaned.metadata as Record<string, unknown>).labels).toEqual({ app: "web" });
  });

  test("does not mutate the input", () => {
    const input = liveDeployment();
    stripServerFields(input);
    expect(input.status).toBeDefined();
    expect(input.metadata.managedFields).toBeDefined();
  });
});

describe("buildExportFromObjects (#116)", () => {
  test("maps live objects to export IR, stripped by default", () => {
    const ir = buildExportFromObjects([liveDeployment(), liveService()]);
    expect(ir.resources).toHaveLength(2);
    const dep = ir.resources.find((r) => r.type === "K8s::Apps::Deployment")!;
    expect(dep.properties.status).toBeUndefined();
    expect((dep.properties.metadata as Record<string, unknown>).uid).toBeUndefined();
  });

  test("verbatim keeps server fields", () => {
    const ir = buildExportFromObjects([liveDeployment()], { verbatim: true });
    const dep = ir.resources[0];
    expect(dep.properties.status).toBeDefined();
    expect((dep.properties.metadata as Record<string, unknown>).uid).toBe("abc-123");
  });

  test("selector by type narrows the export", () => {
    const ir = buildExportFromObjects([liveDeployment(), liveService()], {
      selector: { type: "K8s::Core::Service" },
    });
    expect(ir.resources.map((r) => r.type)).toEqual(["K8s::Core::Service"]);
  });

  test("selector by name matches the live resource name", () => {
    const ir = buildExportFromObjects([liveDeployment(), liveService()], {
      selector: { name: "web" },
    });
    // Both are named "web" — name alone keeps both kinds.
    expect(ir.resources).toHaveLength(2);
  });

  test("export IR feeds K8sGenerator (templateGenerator) unchanged", () => {
    const ir = buildExportFromObjects([liveDeployment()]);
    const files = new K8sGenerator().generate(ir);
    expect(files.length).toBeGreaterThan(0);
    expect(files.map((f) => f.content).join("\n")).toContain("Deployment");
  });
});
