import { describe, test, expect } from "bun:test";
import { K8sGenerator } from "./generator";
import type { TemplateIR, ResourceIR } from "@intentius/chant/import/parser";

const generator = new K8sGenerator();

function makeIR(resources: ResourceIR[]): TemplateIR {
  return { resources, parameters: [] };
}

describe("K8sGenerator", () => {
  test("generates valid TypeScript from IR", () => {
    const ir = makeIR([
      {
        logicalId: "deploymentApp",
        type: "K8s::Apps::Deployment",
        properties: {
          metadata: { name: "app" },
          spec: { replicas: 2 },
        },
      },
    ]);
    const files = generator.generate(ir);
    expect(files.length).toBe(1);
    expect(files[0].path).toBe("main.ts");
    expect(files[0].content).toContain("import");
    expect(files[0].content).toContain("Deployment");
  });

  test("imports correct classes", () => {
    const ir = makeIR([
      {
        logicalId: "svc",
        type: "K8s::Core::Service",
        properties: { metadata: { name: "svc" } },
      },
    ]);
    const files = generator.generate(ir);
    expect(files[0].content).toContain(
      'from "@intentius/chant-lexicon-k8s"',
    );
    expect(files[0].content).toContain("Service");
  });

  test("uses new Constructor() syntax", () => {
    const ir = makeIR([
      {
        logicalId: "deploy",
        type: "K8s::Apps::Deployment",
        properties: {
          metadata: { name: "app" },
          spec: { replicas: 1 },
        },
      },
    ]);
    const files = generator.generate(ir);
    expect(files[0].content).toContain("new Deployment(");
  });

  test("handles array properties (containers, env)", () => {
    const ir = makeIR([
      {
        logicalId: "pod",
        type: "K8s::Core::Pod",
        properties: {
          metadata: { name: "pod" },
          spec: {
            containers: [
              { name: "app", image: "nginx:1.0" },
            ],
          },
        },
      },
    ]);
    const files = generator.generate(ir);
    expect(files[0].content).toContain("Container");
    expect(files[0].content).toContain("nginx:1.0");
  });

  test("generates exports for each resource", () => {
    const ir = makeIR([
      {
        logicalId: "deploy",
        type: "K8s::Apps::Deployment",
        properties: { metadata: { name: "app" } },
      },
      {
        logicalId: "svc",
        type: "K8s::Core::Service",
        properties: { metadata: { name: "svc" } },
      },
    ]);
    const files = generator.generate(ir);
    expect(files[0].content).toContain("export const deploy");
    expect(files[0].content).toContain("export const svc");
  });

  test("Service ports use ServicePort constructor", () => {
    const ir = makeIR([
      {
        logicalId: "svc",
        type: "K8s::Core::Service",
        properties: {
          metadata: { name: "svc" },
          spec: {
            ports: [{ port: 80, targetPort: 8080 }],
          },
        },
      },
    ]);
    const files = generator.generate(ir);
    expect(files[0].content).toContain("ServicePort");
  });

  test("handles empty IR", () => {
    const ir = makeIR([]);
    const files = generator.generate(ir);
    expect(files.length).toBe(1);
    // Should still have an import line (even if no resources)
  });
});
