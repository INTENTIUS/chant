import { describe, test, expect } from "bun:test";
import { wgc204 } from "./wgc204";

function makeCtx(yaml: string) {
  return {
    outputs: new Map([["gcp", yaml]]),
  };
}

describe("WGC204: missing shielded VM config", () => {
  test("flags ComputeInstance without shielded VM", () => {
    const yaml = `apiVersion: compute.cnrm.cloud.google.com/v1beta1
kind: ComputeInstance
metadata:
  name: my-vm
spec:
  machineType: e2-medium
  zone: us-central1-a
`;
    const diags = wgc204.check(makeCtx(yaml));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("WGC204");
    expect(diags[0].severity).toBe("info");
  });

  test("no diagnostic when shielded VM configured", () => {
    const yaml = `apiVersion: compute.cnrm.cloud.google.com/v1beta1
kind: ComputeInstance
metadata:
  name: my-vm
spec:
  machineType: e2-medium
  zone: us-central1-a
  shieldedInstanceConfig:
    enableSecureBoot: true
    enableVtpm: true
    enableIntegrityMonitoring: true
`;
    const diags = wgc204.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
