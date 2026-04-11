import { describe, test, expect } from "vitest";
import { wgc113 } from "./wgc113";

function makeCtx(yaml: string) {
  return {
    outputs: new Map([["gcp", yaml]]),
  };
}

describe("WGC113: alpha API version", () => {
  test("flags resource with v1alpha1 apiVersion", () => {
    const yaml = `apiVersion: compute.cnrm.cloud.google.com/v1alpha1
kind: ComputeInstance
metadata:
  name: my-vm
spec:
  machineType: e2-medium
`;
    const diags = wgc113.check(makeCtx(yaml));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("WGC113");
    expect(diags[0].severity).toBe("warning");
  });

  test("no diagnostic with v1beta1 apiVersion", () => {
    const yaml = `apiVersion: compute.cnrm.cloud.google.com/v1beta1
kind: ComputeInstance
metadata:
  name: my-vm
spec:
  machineType: e2-medium
`;
    const diags = wgc113.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
