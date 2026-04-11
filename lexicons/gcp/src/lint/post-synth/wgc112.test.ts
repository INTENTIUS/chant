import { describe, test, expect } from "vitest";
import { wgc112 } from "./wgc112";

function makeCtx(yaml: string) {
  return {
    outputs: new Map([["gcp", yaml]]),
  };
}

describe("WGC112: missing or invalid apiVersion", () => {
  test("flags resource with missing apiVersion", () => {
    const yaml = `kind: StorageBucket
metadata:
  name: my-bucket
spec:
  location: US
`;
    const diags = wgc112.check(makeCtx(yaml));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("WGC112");
    expect(diags[0].severity).toBe("error");
  });

  test("flags resource with malformed apiVersion", () => {
    const yaml = `apiVersion: not-a-valid-version
kind: StorageBucket
metadata:
  name: my-bucket
spec:
  location: US
`;
    const diags = wgc112.check(makeCtx(yaml));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("WGC112");
  });

  test("no diagnostic with valid apiVersion", () => {
    const yaml = `apiVersion: storage.cnrm.cloud.google.com/v1beta1
kind: StorageBucket
metadata:
  name: my-bucket
spec:
  location: US
`;
    const diags = wgc112.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
