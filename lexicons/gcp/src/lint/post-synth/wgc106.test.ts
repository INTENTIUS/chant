import { describe, test, expect } from "vitest";
import { wgc106 } from "./wgc106";

function makeCtx(yaml: string) {
  return {
    outputs: new Map([["gcp", yaml]]),
  };
}

describe("WGC106: missing deletion policy", () => {
  test("flags resource without deletion policy annotation", () => {
    const yaml = `apiVersion: storage.cnrm.cloud.google.com/v1beta1
kind: StorageBucket
metadata:
  name: my-bucket
spec:
  location: US
`;
    const diags = wgc106.check(makeCtx(yaml));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("WGC106");
    expect(diags[0].severity).toBe("info");
  });

  test("no diagnostic when deletion policy present", () => {
    const yaml = `apiVersion: storage.cnrm.cloud.google.com/v1beta1
kind: StorageBucket
metadata:
  name: my-bucket
  annotations:
    cnrm.cloud.google.com/deletion-policy: abandon
spec:
  location: US
`;
    const diags = wgc106.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
