import { describe, test, expect } from "vitest";
import { GcpGenerator } from "./generator";

const generator = new GcpGenerator();

function makeIR(resources: any[]) {
  return { resources, parameters: [], outputs: [] };
}

describe("GcpGenerator", () => {
  test("generates valid TypeScript from IR", () => {
    const ir = makeIR([
      {
        logicalName: "my-bucket",
        type: "GCP::Storage::Bucket",
        properties: {
          metadata: { name: "my-bucket" },
          location: "US",
        },
      },
    ]);
    const result = generator.generate(ir);
    expect(result).toContain("import");
    expect(result).toContain("Bucket");
  });

  test("correct import source (@intentius/chant-lexicon-gcp)", () => {
    const ir = makeIR([
      {
        logicalName: "my-bucket",
        type: "GCP::Storage::Bucket",
        properties: { location: "US" },
      },
    ]);
    const result = generator.generate(ir);
    expect(result).toContain('from "@intentius/chant-lexicon-gcp"');
  });

  test("multiple resources produce multiple exports", () => {
    const ir = makeIR([
      {
        logicalName: "my-bucket",
        type: "GCP::Storage::Bucket",
        properties: { location: "US" },
      },
      {
        logicalName: "my-vm",
        type: "GCP::Compute::Instance",
        properties: { machineType: "e2-medium" },
      },
    ]);
    const result = generator.generate(ir);
    expect(result).toContain("export const myBucket");
    expect(result).toContain("export const myVm");
  });

  test("camelCase variable names from kebab-case logical names", () => {
    const ir = makeIR([
      {
        logicalName: "my-data-bucket",
        type: "GCP::Storage::Bucket",
        properties: { location: "US" },
      },
    ]);
    const result = generator.generate(ir);
    expect(result).toContain("export const myDataBucket");
  });

  test("empty IR produces minimal output", () => {
    const ir = makeIR([]);
    const result = generator.generate(ir);
    // Should still produce valid TypeScript, even if no resources
    expect(typeof result).toBe("string");
  });

  test("nested object formatting", () => {
    const ir = makeIR([
      {
        logicalName: "my-bucket",
        type: "GCP::Storage::Bucket",
        properties: {
          location: "US",
          versioning: { enabled: true },
        },
      },
    ]);
    const result = generator.generate(ir);
    expect(result).toContain("versioning:");
    expect(result).toContain("enabled: true");
  });

  test("uses new Constructor() syntax", () => {
    const ir = makeIR([
      {
        logicalName: "my-bucket",
        type: "GCP::Storage::Bucket",
        properties: { location: "US" },
      },
    ]);
    const result = generator.generate(ir);
    expect(result).toContain("new Bucket(");
  });

  test("sorts imports alphabetically", () => {
    const ir = makeIR([
      {
        logicalName: "vm",
        type: "GCP::Compute::Instance",
        properties: { machineType: "e2-medium" },
      },
      {
        logicalName: "bucket",
        type: "GCP::Storage::Bucket",
        properties: { location: "US" },
      },
    ]);
    const result = generator.generate(ir);
    const importLine = result.split("\n").find((l: string) => l.startsWith("import"));
    expect(importLine).toBeDefined();
    // Bucket should come before Instance alphabetically
    const bucketIdx = importLine!.indexOf("Bucket");
    const instanceIdx = importLine!.indexOf("Instance");
    expect(bucketIdx).toBeLessThan(instanceIdx);
  });
});
