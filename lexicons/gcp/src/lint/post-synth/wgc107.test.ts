import { describe, test, expect } from "vitest";
import { wgc107 } from "./wgc107";

function makeCtx(yaml: string) {
  return {
    outputs: new Map([["gcp", yaml]]),
  };
}

describe("WGC107: missing versioning", () => {
  test("flags StorageBucket without versioning", () => {
    const yaml = `apiVersion: storage.cnrm.cloud.google.com/v1beta1
kind: StorageBucket
metadata:
  name: my-bucket
spec:
  location: US
`;
    const diags = wgc107.check(makeCtx(yaml));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("WGC107");
    expect(diags[0].severity).toBe("info");
  });

  test("no diagnostic when versioning enabled", () => {
    const yaml = `apiVersion: storage.cnrm.cloud.google.com/v1beta1
kind: StorageBucket
metadata:
  name: my-bucket
spec:
  location: US
  versioning:
    enabled: true
`;
    const diags = wgc107.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
