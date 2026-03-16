import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { GcpParser } from "./parser";
import { GcpGenerator } from "./generator";

const testdataDir = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  "testdata",
  "manifests",
);

const parser = new GcpParser();
const generator = new GcpGenerator();

describe("roundtrip: parse YAML → generate TypeScript", () => {
  test("StorageBucket roundtrip", () => {
    const yaml = readFileSync(join(testdataDir, "storage-bucket.yaml"), "utf-8");
    const ir = parser.parse(yaml);
    const ts = generator.generate(ir);

    expect(ir.resources.length).toBe(1);
    expect(ts).toContain("new Bucket");
    expect(ts).toContain("export const");
  });

  test("ComputeInstance roundtrip", () => {
    const yaml = readFileSync(join(testdataDir, "compute-instance.yaml"), "utf-8");
    const ir = parser.parse(yaml);
    const ts = generator.generate(ir);

    expect(ir.resources.length).toBe(1);
    expect(ts).toContain("new Instance");
    expect(ts).toContain("export const");
    expect(ts).toContain("e2-medium");
  });

  test("multi-doc full-app roundtrip", () => {
    const yaml = readFileSync(join(testdataDir, "full-app.yaml"), "utf-8");
    const ir = parser.parse(yaml);
    expect(ir.resources.length).toBe(3); // StorageBucket + IAMPolicyMember + ComputeNetwork

    const ts = generator.generate(ir);
    expect(ts).toContain("Bucket");
    expect(ts).toContain("PolicyMember");
    expect(ts).toContain("Network");
  });

  test("inline YAML roundtrip", () => {
    const yaml = `
apiVersion: storage.cnrm.cloud.google.com/v1beta1
kind: StorageBucket
metadata:
  name: inline-test
spec:
  location: EU
  storageClass: NEARLINE
`;
    const ir = parser.parse(yaml);
    const ts = generator.generate(ir);

    expect(ts).toContain("new Bucket");
    expect(ts).toContain("export const");
  });
});
