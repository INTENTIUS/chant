import { describe, test, expect } from "vitest";
import { wgc302 } from "./wgc302";

function makeCtx(yaml: string) {
  return {
    outputs: new Map([["gcp", yaml]]),
  };
}

describe("WGC302: service API not enabled", () => {
  test("flags output without Service resource", () => {
    const yaml = `apiVersion: storage.cnrm.cloud.google.com/v1beta1
kind: StorageBucket
metadata:
  name: my-bucket
spec:
  location: US
`;
    const diags = wgc302.check(makeCtx(yaml));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("WGC302");
    expect(diags[0].severity).toBe("info");
  });

  test("no diagnostic when Service resource present", () => {
    const yaml = `apiVersion: serviceusage.cnrm.cloud.google.com/v1beta1
kind: Service
metadata:
  name: compute-api
spec:
  resourceID: compute.googleapis.com
`;
    const diags = wgc302.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
