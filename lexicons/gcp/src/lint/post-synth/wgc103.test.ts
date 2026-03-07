import { describe, test, expect } from "bun:test";
import { wgc103 } from "./wgc103";

function makeCtx(yaml: string) {
  return {
    outputs: new Map([["gcp", yaml]]),
  };
}

describe("WGC103: missing project annotation", () => {
  test("flags resource without project annotation", () => {
    const yaml = `apiVersion: storage.cnrm.cloud.google.com/v1beta1
kind: StorageBucket
metadata:
  name: my-bucket
spec:
  location: US
`;
    const diags = wgc103.check(makeCtx(yaml));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("WGC103");
    expect(diags[0].severity).toBe("info");
  });

  test("no diagnostic when project annotation present", () => {
    const yaml = `apiVersion: storage.cnrm.cloud.google.com/v1beta1
kind: StorageBucket
metadata:
  name: my-bucket
  annotations:
    cnrm.cloud.google.com/project-id: my-project
spec:
  location: US
`;
    const diags = wgc103.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
