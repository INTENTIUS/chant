import { describe, test, expect } from "vitest";
import { wgc202 } from "./wgc202";

function makeCtx(yaml: string) {
  return {
    outputs: new Map([["gcp", yaml]]),
  };
}

describe("WGC202: missing workload identity", () => {
  test("flags ContainerCluster without workload identity", () => {
    const yaml = `apiVersion: container.cnrm.cloud.google.com/v1beta1
kind: ContainerCluster
metadata:
  name: my-cluster
spec:
  location: us-central1
`;
    const diags = wgc202.check(makeCtx(yaml));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("WGC202");
    expect(diags[0].severity).toBe("warning");
  });

  test("no diagnostic when workload identity configured", () => {
    const yaml = `apiVersion: container.cnrm.cloud.google.com/v1beta1
kind: ContainerCluster
metadata:
  name: my-cluster
spec:
  location: us-central1
  workloadIdentityConfig:
    workloadPool: my-project.svc.id.goog
`;
    const diags = wgc202.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
