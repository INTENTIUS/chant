import { describe, test, expect } from "vitest";
import { wgc104 } from "./wgc104";

function makeCtx(yaml: string) {
  return {
    outputs: new Map([["gcp", yaml]]),
  };
}

describe("WGC104: missing uniform bucket access", () => {
  test("flags StorageBucket without uniformBucketLevelAccess", () => {
    const yaml = `apiVersion: storage.cnrm.cloud.google.com/v1beta1
kind: StorageBucket
metadata:
  name: my-bucket
spec:
  location: US
`;
    const diags = wgc104.check(makeCtx(yaml));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("WGC104");
    expect(diags[0].severity).toBe("warning");
  });

  test("no diagnostic when uniformBucketLevelAccess is true", () => {
    const yaml = `apiVersion: storage.cnrm.cloud.google.com/v1beta1
kind: StorageBucket
metadata:
  name: my-bucket
spec:
  location: US
  uniformBucketLevelAccess: true
`;
    const diags = wgc104.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
