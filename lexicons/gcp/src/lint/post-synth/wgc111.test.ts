import { describe, test, expect } from "vitest";
import { wgc111 } from "./wgc111";

function makeCtx(yaml: string) {
  return {
    outputs: new Map([["gcp", yaml]]),
  };
}

describe("WGC111: dangling resource reference", () => {
  test("flags resourceRef pointing to nonexistent name", () => {
    const yaml = `apiVersion: container.cnrm.cloud.google.com/v1beta1
kind: ContainerNodePool
metadata:
  name: my-pool
spec:
  clusterRef:
    name: nonexistent-cluster
`;
    const diags = wgc111.check(makeCtx(yaml));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("WGC111");
    expect(diags[0].severity).toBe("warning");
  });

  test("no diagnostic when referenced resource exists", () => {
    const yaml = `apiVersion: container.cnrm.cloud.google.com/v1beta1
kind: ContainerCluster
metadata:
  name: my-cluster
spec:
  location: us-central1
---
apiVersion: container.cnrm.cloud.google.com/v1beta1
kind: ContainerNodePool
metadata:
  name: my-pool
spec:
  clusterRef:
    name: my-cluster
`;
    const diags = wgc111.check(makeCtx(yaml));
    const poolDiags = diags.filter(d => d.entity === "my-pool");
    expect(poolDiags).toHaveLength(0);
  });
});
