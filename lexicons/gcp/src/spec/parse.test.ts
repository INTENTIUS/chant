import { describe, test, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  parseGcpCRD,
  gcpServiceName,
  stripServicePrefix,
  gcpTypeName,
  gcpShortName,
} from "./parse";

const __dirname_ = dirname(fileURLToPath(import.meta.url));
const testdata = join(__dirname_, "..", "testdata");

describe("gcpServiceName", () => {
  test("extracts service from CNRM group", () => {
    expect(gcpServiceName("compute.cnrm.cloud.google.com")).toBe("Compute");
    expect(gcpServiceName("storage.cnrm.cloud.google.com")).toBe("Storage");
    expect(gcpServiceName("iam.cnrm.cloud.google.com")).toBe("Iam");
    expect(gcpServiceName("container.cnrm.cloud.google.com")).toBe("Container");
    expect(gcpServiceName("sql.cnrm.cloud.google.com")).toBe("Sql");
  });
});

describe("stripServicePrefix", () => {
  test("strips known prefix", () => {
    expect(stripServicePrefix("ComputeInstance", "Compute")).toBe("Instance");
    expect(stripServicePrefix("StorageBucket", "Storage")).toBe("Bucket");
    expect(stripServicePrefix("IAMPolicyMember", "IAM")).toBe("PolicyMember");
  });

  test("returns kind if no prefix match", () => {
    expect(stripServicePrefix("VPCNetwork", "Compute")).toBe("VPCNetwork");
  });
});

describe("gcpTypeName", () => {
  test("builds full type name", () => {
    expect(gcpTypeName("compute.cnrm.cloud.google.com", "ComputeInstance")).toBe("GCP::Compute::Instance");
    expect(gcpTypeName("storage.cnrm.cloud.google.com", "StorageBucket")).toBe("GCP::Storage::Bucket");
  });
});

describe("gcpShortName", () => {
  test("extracts short name", () => {
    expect(gcpShortName("GCP::Compute::Instance")).toBe("Instance");
    expect(gcpShortName("GCP::Storage::Bucket")).toBe("Bucket");
  });
});

describe("parseGcpCRD", () => {
  test("parses ComputeInstance CRD", () => {
    const content = readFileSync(join(testdata, "compute-instance.yaml"), "utf-8");
    const results = parseGcpCRD(content);

    expect(results).toHaveLength(1);
    const result = results[0];

    expect(result.resource.typeName).toBe("GCP::Compute::Instance");
    expect(result.gvk.group).toBe("compute.cnrm.cloud.google.com");
    expect(result.gvk.version).toBe("v1beta1");
    expect(result.gvk.kind).toBe("ComputeInstance");

    // Check properties
    const propNames = result.resource.properties.map((p) => p.name);
    expect(propNames).toContain("machineType");
    expect(propNames).toContain("zone");
    expect(propNames).toContain("canIpForward");
    expect(propNames).toContain("tags");

    // Check required
    const machineType = result.resource.properties.find((p) => p.name === "machineType")!;
    expect(machineType.required).toBe(true);
    expect(machineType.tsType).toBe("string");

    // Check resourceRef detection
    const netRef = result.resource.properties.find((p) => p.name === "networkInterfaceRef");
    expect(netRef).toBeDefined();
    expect(netRef!.isResourceRef).toBe(true);

    // Check attributes
    expect(result.resource.attributes).toHaveLength(3);
    expect(result.resource.attributes[0].name).toBe("name");
  });

  test("parses StorageBucket CRD", () => {
    const content = readFileSync(join(testdata, "storage-bucket.yaml"), "utf-8");
    const results = parseGcpCRD(content);

    expect(results).toHaveLength(1);
    const result = results[0];

    expect(result.resource.typeName).toBe("GCP::Storage::Bucket");

    // Check enum
    const storageClass = result.resource.properties.find((p) => p.name === "storageClass");
    expect(storageClass).toBeDefined();
    expect(storageClass!.enum).toContain("STANDARD");
    expect(storageClass!.enum).toContain("NEARLINE");

    // Check property types (nested objects)
    expect(result.propertyTypes.length).toBeGreaterThan(0);
    const versioning = result.propertyTypes.find((pt) => pt.specType === "versioning");
    expect(versioning).toBeDefined();
  });

  test("parses IAMPolicyMember CRD", () => {
    const content = readFileSync(join(testdata, "iam-policy-member.yaml"), "utf-8");
    const results = parseGcpCRD(content);

    expect(results).toHaveLength(1);
    const result = results[0];

    expect(result.resource.typeName).toBe("GCP::Iam::PolicyMember");

    // Check required properties
    const member = result.resource.properties.find((p) => p.name === "member")!;
    expect(member.required).toBe(true);

    const role = result.resource.properties.find((p) => p.name === "role")!;
    expect(role.required).toBe(true);

    // resourceRef should be detected
    const resRef = result.resource.properties.find((p) => p.name === "resourceRef");
    expect(resRef).toBeDefined();
    expect(resRef!.isResourceRef).toBe(true);
  });

  test("handles multi-document CRD bundle", () => {
    const content = [
      readFileSync(join(testdata, "compute-instance.yaml"), "utf-8"),
      readFileSync(join(testdata, "storage-bucket.yaml"), "utf-8"),
    ].join("\n---\n");

    const results = parseGcpCRD(content);
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.resource.typeName)).toContain("GCP::Compute::Instance");
    expect(results.map((r) => r.resource.typeName)).toContain("GCP::Storage::Bucket");
  });

  test("skips non-CNRM CRDs", () => {
    const content = `
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: foo.example.com
spec:
  group: example.com
  names:
    kind: Foo
  versions:
    - name: v1
      served: true
      storage: true
      schema:
        openAPIV3Schema:
          type: object
`;
    const results = parseGcpCRD(content);
    expect(results).toHaveLength(0);
  });
});
