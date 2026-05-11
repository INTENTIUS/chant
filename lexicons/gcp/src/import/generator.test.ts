import { describe, test, expect } from "vitest";
import { GcpGenerator } from "./generator";

const generator = new GcpGenerator();

function makeIR(resources: any[]) {
  return { resources, parameters: [] };
}

function content(ir: ReturnType<typeof makeIR>): string {
  const files = generator.generate(ir);
  return files[0].content;
}

describe("GcpGenerator", () => {
  test("generates valid TypeScript from IR", () => {
    const ir = makeIR([
      {
        logicalId: "my-bucket",
        type: "GCP::Storage::Bucket",
        properties: {
          metadata: { name: "my-bucket" },
          location: "US",
        },
      },
    ]);
    const result = content(ir);
    expect(result).toContain("import");
    expect(result).toContain("Bucket");
  });

  test("correct import source (@intentius/chant-lexicon-gcp)", () => {
    const ir = makeIR([
      {
        logicalId: "my-bucket",
        type: "GCP::Storage::Bucket",
        properties: { location: "US" },
      },
    ]);
    expect(content(ir)).toContain('from "@intentius/chant-lexicon-gcp"');
  });

  test("multiple resources produce multiple exports", () => {
    const ir = makeIR([
      {
        logicalId: "my-bucket",
        type: "GCP::Storage::Bucket",
        properties: { location: "US" },
      },
      {
        logicalId: "my-vm",
        type: "GCP::Compute::Instance",
        properties: { machineType: "e2-medium" },
      },
    ]);
    const result = content(ir);
    expect(result).toContain("export const myBucket");
    expect(result).toContain("export const myVm");
  });

  test("camelCase variable names from kebab-case logical names", () => {
    const ir = makeIR([
      {
        logicalId: "my-data-bucket",
        type: "GCP::Storage::Bucket",
        properties: { location: "US" },
      },
    ]);
    expect(content(ir)).toContain("export const myDataBucket");
  });

  test("empty IR still produces a generated file", () => {
    const ir = makeIR([]);
    const files = generator.generate(ir);
    expect(files).toHaveLength(1);
    expect(typeof files[0].content).toBe("string");
  });

  test("nested object formatting", () => {
    const ir = makeIR([
      {
        logicalId: "my-bucket",
        type: "GCP::Storage::Bucket",
        properties: {
          location: "US",
          versioning: { enabled: true },
        },
      },
    ]);
    const result = content(ir);
    expect(result).toContain("versioning:");
    expect(result).toContain("enabled: true");
  });

  test("uses new Constructor() syntax", () => {
    const ir = makeIR([
      {
        logicalId: "my-bucket",
        type: "GCP::Storage::Bucket",
        properties: { location: "US" },
      },
    ]);
    expect(content(ir)).toContain("new Bucket(");
  });

  test("sorts imports alphabetically", () => {
    const ir = makeIR([
      {
        logicalId: "vm",
        type: "GCP::Compute::Instance",
        properties: { machineType: "e2-medium" },
      },
      {
        logicalId: "bucket",
        type: "GCP::Storage::Bucket",
        properties: { location: "US" },
      },
    ]);
    const result = content(ir);
    const importLine = result.split("\n").find((l: string) => l.startsWith("import"));
    expect(importLine).toBeDefined();
    // Bucket should come before Instance alphabetically
    const bucketIdx = importLine!.indexOf("Bucket");
    const instanceIdx = importLine!.indexOf("Instance");
    expect(bucketIdx).toBeLessThan(instanceIdx);
  });
});
