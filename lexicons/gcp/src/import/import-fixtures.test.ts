import { describe, test, expect } from "bun:test";
import { GcpParser } from "./parser";
import { GcpGenerator } from "./generator";

const parser = new GcpParser();

describe("GCP import with inline YAML fixtures", () => {
  test("parses a single StorageBucket manifest", () => {
    const yaml = `apiVersion: storage.cnrm.cloud.google.com/v1beta1
kind: StorageBucket
metadata:
  name: my-bucket
spec:
  location: US
  uniformBucketLevelAccess: true
`;
    const ir = parser.parse(yaml);
    expect(ir.resources).toHaveLength(1);
    expect(ir.resources[0].logicalName).toBe("my-bucket");
    expect(ir.resources[0].type).toContain("StorageBucket");
  });

  test("parses multi-document YAML into multiple resources", () => {
    const yaml = `apiVersion: compute.cnrm.cloud.google.com/v1beta1
kind: ComputeNetwork
metadata:
  name: my-network
spec:
  autoCreateSubnetworks: false
---
apiVersion: compute.cnrm.cloud.google.com/v1beta1
kind: ComputeSubnetwork
metadata:
  name: my-subnet
spec:
  region: us-central1
  ipCidrRange: "10.0.0.0/24"
  networkRef:
    name: my-network
`;
    const ir = parser.parse(yaml);
    expect(ir.resources).toHaveLength(2);
    expect(ir.resources[0].logicalName).toBe("my-network");
    expect(ir.resources[1].logicalName).toBe("my-subnet");
  });

  test("skips non-Config-Connector resources", () => {
    const yaml = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-deploy
spec:
  replicas: 3
---
apiVersion: storage.cnrm.cloud.google.com/v1beta1
kind: StorageBucket
metadata:
  name: my-bucket
spec:
  location: US
`;
    const ir = parser.parse(yaml);
    expect(ir.resources).toHaveLength(1);
    expect(ir.resources[0].type).toContain("StorageBucket");
  });

  test("preserves spec properties in parsed IR", () => {
    const yaml = `apiVersion: sql.cnrm.cloud.google.com/v1beta1
kind: SQLInstance
metadata:
  name: my-db
spec:
  databaseVersion: POSTGRES_15
  settings:
    tier: db-f1-micro
    backupConfiguration:
      enabled: true
`;
    const ir = parser.parse(yaml);
    expect(ir.resources).toHaveLength(1);
    expect(ir.resources[0].properties.databaseVersion).toBe("POSTGRES_15");
  });

  test("round-trips through parser and generator", () => {
    const yaml = `apiVersion: storage.cnrm.cloud.google.com/v1beta1
kind: StorageBucket
metadata:
  name: my-bucket
spec:
  location: US
`;
    const ir = parser.parse(yaml);
    const generator = new GcpGenerator();
    const ts = generator.generate(ir);
    expect(ts).toContain("StorageBucket");
    expect(ts).toContain("import");
  });
});
