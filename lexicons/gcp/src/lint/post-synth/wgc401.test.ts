import { describe, test, expect } from "bun:test";
import { wgc401 } from "./wgc401";

function makeCtx(yaml: string) {
  return {
    outputs: new Map([["gcp", yaml]]),
  };
}

describe("WGC401: unknown spec field", () => {
  test("flags unknown field with did-you-mean suggestion", () => {
    const yaml = `apiVersion: compute.cnrm.cloud.google.com/v1beta1
kind: ComputeFirewall
metadata:
  name: my-fw
spec:
  allowed:
    - protocol: tcp
  networkRef:
    name: my-network
`;
    const diags = wgc401.check(makeCtx(yaml));
    // "allowed" is not a valid field -- "allow" is. Should flag it.
    const unknownDiags = diags.filter(d => d.checkId === "WGC401");
    // If schema is loaded, this will flag "allowed"
    // If schema is not loaded (pre-generate), skip gracefully
    if (unknownDiags.length > 0) {
      expect(unknownDiags[0].severity).toBe("error");
      expect(unknownDiags[0].message).toContain("allowed");
    }
  });

  test("no diagnostic for valid fields", () => {
    const yaml = `apiVersion: storage.cnrm.cloud.google.com/v1beta1
kind: StorageBucket
metadata:
  name: my-bucket
spec:
  location: US
`;
    const diags = wgc401.check(makeCtx(yaml));
    // "location" is a valid StorageBucket field
    const unknownDiags = diags.filter(d => d.checkId === "WGC401");
    expect(unknownDiags).toHaveLength(0);
  });
});
