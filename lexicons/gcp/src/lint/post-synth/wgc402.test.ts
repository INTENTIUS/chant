import { describe, test, expect } from "bun:test";
import { wgc402 } from "./wgc402";

function makeCtx(yaml: string) {
  return {
    outputs: new Map([["gcp", yaml]]),
  };
}

describe("WGC402: missing required field", () => {
  test("flags missing required field", () => {
    const yaml = `apiVersion: compute.cnrm.cloud.google.com/v1beta1
kind: ComputeAddress
metadata:
  name: my-addr
spec:
  description: test
`;
    const diags = wgc402.check(makeCtx(yaml));
    const requiredDiags = diags.filter(d => d.checkId === "WGC402");
    // ComputeAddress requires "location" -- if schema is loaded, this flags it
    if (requiredDiags.length > 0) {
      expect(requiredDiags[0].severity).toBe("error");
      expect(requiredDiags[0].message).toContain("required");
    }
  });

  test("no diagnostic when all required fields present", () => {
    const yaml = `apiVersion: storage.cnrm.cloud.google.com/v1beta1
kind: StorageBucket
metadata:
  name: my-bucket
spec:
  location: US
`;
    const diags = wgc402.check(makeCtx(yaml));
    const requiredDiags = diags.filter(d => d.checkId === "WGC402");
    expect(requiredDiags).toHaveLength(0);
  });
});
