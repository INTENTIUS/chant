import { describe, test, expect } from "bun:test";
import { wgc201 } from "./wgc201";

function makeCtx(yaml: string) {
  return {
    outputs: new Map([["gcp", yaml]]),
  };
}

describe("WGC201: missing managed-by label", () => {
  test("flags resource without managed-by label", () => {
    const yaml = `apiVersion: storage.cnrm.cloud.google.com/v1beta1
kind: StorageBucket
metadata:
  name: my-bucket
spec:
  location: US
`;
    const diags = wgc201.check(makeCtx(yaml));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("WGC201");
    expect(diags[0].severity).toBe("info");
  });

  test("no diagnostic when managed-by label present", () => {
    const yaml = `apiVersion: storage.cnrm.cloud.google.com/v1beta1
kind: StorageBucket
metadata:
  name: my-bucket
  labels:
    app.kubernetes.io/managed-by: chant
spec:
  location: US
`;
    const diags = wgc201.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
