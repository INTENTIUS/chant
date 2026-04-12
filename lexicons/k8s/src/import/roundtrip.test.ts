import { describe, test, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { K8sParser } from "./parser";
import { K8sGenerator } from "./generator";

const testdataDir = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  "testdata",
  "manifests",
);

const parser = new K8sParser();
const generator = new K8sGenerator();

describe("roundtrip: parse YAML → generate TypeScript", () => {
  test("Deployment roundtrip", () => {
    const yaml = readFileSync(join(testdataDir, "deployment.yaml"), "utf-8");
    const ir = parser.parse(yaml);
    const files = generator.generate(ir);

    expect(files.length).toBe(1);
    expect(files[0].content).toContain("new Deployment");
    expect(files[0].content).toContain("nginx");
  });

  test("multi-doc full-app roundtrip", () => {
    const yaml = readFileSync(join(testdataDir, "full-app.yaml"), "utf-8");
    const ir = parser.parse(yaml);
    expect(ir.resources.length).toBe(4); // Deployment + Service + Ingress + ConfigMap

    const files = generator.generate(ir);
    expect(files[0].content).toContain("Deployment");
    expect(files[0].content).toContain("Service");
    expect(files[0].content).toContain("Ingress");
    expect(files[0].content).toContain("ConfigMap");
  });

  test("Service roundtrip preserves port info", () => {
    const yaml = readFileSync(join(testdataDir, "service.yaml"), "utf-8");
    const ir = parser.parse(yaml);
    const files = generator.generate(ir);

    expect(files[0].content).toContain("new Service");
    expect(files[0].content).toContain("80");
  });

  test("ConfigMap roundtrip preserves data", () => {
    const yaml = readFileSync(join(testdataDir, "configmap.yaml"), "utf-8");
    const ir = parser.parse(yaml);
    const files = generator.generate(ir);

    expect(files[0].content).toContain("ConfigMap");
    expect(files[0].content).toContain("DATABASE_URL");
  });

  test("inline YAML roundtrip", () => {
    const yaml = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: test-app
spec:
  replicas: 1
  selector:
    matchLabels:
      app: test
  template:
    metadata:
      labels:
        app: test
    spec:
      containers:
        - name: test
          image: test:1.0
          ports:
            - containerPort: 8080
`;
    const ir = parser.parse(yaml);
    const files = generator.generate(ir);

    expect(files[0].content).toContain("new Deployment");
    expect(files[0].content).toContain("export const");
  });
});
