import { describe, test, expect } from "vitest";
import { wgc109 } from "./wgc109";

function makeCtx(yaml: string) {
  return {
    outputs: new Map([["gcp", yaml]]),
  };
}

describe("WGC109: open firewall", () => {
  test("flags ComputeFirewall with 0.0.0.0/0", () => {
    const yaml = `apiVersion: compute.cnrm.cloud.google.com/v1beta1
kind: ComputeFirewall
metadata:
  name: allow-all
spec:
  sourceRanges:
    - "0.0.0.0/0"
  allowed:
    - protocol: tcp
      ports:
        - "80"
`;
    const diags = wgc109.check(makeCtx(yaml));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("WGC109");
    expect(diags[0].severity).toBe("warning");
  });

  test("no diagnostic with specific source range", () => {
    const yaml = `apiVersion: compute.cnrm.cloud.google.com/v1beta1
kind: ComputeFirewall
metadata:
  name: allow-internal
spec:
  sourceRanges:
    - "10.0.0.0/8"
  allowed:
    - protocol: tcp
      ports:
        - "80"
`;
    const diags = wgc109.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
