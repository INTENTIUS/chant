import { describe, test, expect } from "vitest";
import { GcpParser } from "./parser";

const parser = new GcpParser();

describe("GcpParser", () => {
  test("empty YAML returns empty resources", () => {
    const ir = parser.parse("");
    expect(ir.resources).toEqual([]);
    expect(ir.parameters).toEqual([]);
  });

  test("single ComputeInstance parses correctly", () => {
    const yaml = `
apiVersion: compute.cnrm.cloud.google.com/v1beta1
kind: ComputeInstance
metadata:
  name: my-vm
spec:
  machineType: e2-medium
  zone: us-central1-a
`;
    const ir = parser.parse(yaml);
    expect(ir.resources.length).toBe(1);
    const r = ir.resources[0];
    expect(r.type).toBe("GCP::Compute::Instance");
    expect(r.properties.machineType).toBe("e2-medium");
    expect(r.properties.zone).toBe("us-central1-a");
  });

  test("multi-doc YAML produces multiple resources", () => {
    const yaml = `
apiVersion: storage.cnrm.cloud.google.com/v1beta1
kind: StorageBucket
metadata:
  name: bucket
spec:
  location: US
---
apiVersion: compute.cnrm.cloud.google.com/v1beta1
kind: ComputeInstance
metadata:
  name: vm
spec:
  machineType: e2-medium
`;
    const ir = parser.parse(yaml);
    expect(ir.resources.length).toBe(2);
  });

  test("apiVersion+kind maps to GCP type name", () => {
    const yaml = `
apiVersion: storage.cnrm.cloud.google.com/v1beta1
kind: StorageBucket
metadata:
  name: test
spec:
  location: US
`;
    const ir = parser.parse(yaml);
    expect(ir.resources[0].type).toBe("GCP::Storage::Bucket");
  });

  test("IAM resource maps correctly", () => {
    const yaml = `
apiVersion: iam.cnrm.cloud.google.com/v1beta1
kind: IAMPolicyMember
metadata:
  name: binding
spec:
  member: user:test@example.com
  role: roles/viewer
`;
    const ir = parser.parse(yaml);
    expect(ir.resources[0].type).toBe("GCP::Iam::PolicyMember");
  });

  test("non-Config Connector resources ignored", () => {
    const yaml = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
spec:
  replicas: 1
`;
    const ir = parser.parse(yaml);
    expect(ir.resources).toEqual([]);
  });

  test("metadata.name extracted as logicalName", () => {
    const yaml = `
apiVersion: compute.cnrm.cloud.google.com/v1beta1
kind: ComputeNetwork
metadata:
  name: my-network
spec:
  autoCreateSubnetworks: false
`;
    const ir = parser.parse(yaml);
    expect((ir.resources[0] as any).logicalName).toBe("my-network");
  });

  test("properties include metadata and spec fields, exclude apiVersion/kind", () => {
    const yaml = `
apiVersion: storage.cnrm.cloud.google.com/v1beta1
kind: StorageBucket
metadata:
  name: test
  annotations:
    cnrm.cloud.google.com/project-id: my-project
spec:
  location: US
  storageClass: STANDARD
`;
    const ir = parser.parse(yaml);
    const props = ir.resources[0].properties;
    expect((props as any).apiVersion).toBeUndefined();
    expect((props as any).kind).toBeUndefined();
    expect(props.metadata).toBeDefined();
    expect(props.location).toBe("US");
    expect(props.storageClass).toBe("STANDARD");
  });

  test("parameters are always empty (GCP has no template parameters)", () => {
    const yaml = `
apiVersion: compute.cnrm.cloud.google.com/v1beta1
kind: ComputeInstance
metadata:
  name: test
spec:
  machineType: e2-medium
`;
    const ir = parser.parse(yaml);
    expect(ir.parameters).toEqual([]);
  });

  test("mixed Config Connector and non-CC resources filters correctly", () => {
    const yaml = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app
spec:
  replicas: 1
---
apiVersion: storage.cnrm.cloud.google.com/v1beta1
kind: StorageBucket
metadata:
  name: bucket
spec:
  location: US
---
apiVersion: v1
kind: Service
metadata:
  name: svc
spec:
  ports:
    - port: 80
`;
    const ir = parser.parse(yaml);
    // Only the StorageBucket should be parsed
    expect(ir.resources.length).toBe(1);
    expect(ir.resources[0].type).toBe("GCP::Storage::Bucket");
  });
});
