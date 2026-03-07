import { describe, test, expect } from "bun:test";
import { wgc303 } from "./wgc303";

function makeCtx(yaml: string) {
  return {
    outputs: new Map([["gcp", yaml]]),
  };
}

describe("WGC303: missing VPC Service Controls", () => {
  test("flags output without service perimeter", () => {
    const yaml = `apiVersion: storage.cnrm.cloud.google.com/v1beta1
kind: StorageBucket
metadata:
  name: my-bucket
spec:
  location: US
`;
    const diags = wgc303.check(makeCtx(yaml));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("WGC303");
    expect(diags[0].severity).toBe("info");
  });

  test("no diagnostic when service perimeter present", () => {
    const yaml = `apiVersion: accesscontextmanager.cnrm.cloud.google.com/v1beta1
kind: AccessContextManagerServicePerimeter
metadata:
  name: my-perimeter
spec:
  title: my-perimeter
  perimeterType: PERIMETER_TYPE_REGULAR
`;
    const diags = wgc303.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
