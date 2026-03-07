import { describe, test, expect } from "bun:test";
import { wgc301 } from "./wgc301";

function makeCtx(yaml: string) {
  return {
    outputs: new Map([["gcp", yaml]]),
  };
}

describe("WGC301: no audit logging", () => {
  test("flags output without IAMAuditConfig", () => {
    const yaml = `apiVersion: storage.cnrm.cloud.google.com/v1beta1
kind: StorageBucket
metadata:
  name: my-bucket
spec:
  location: US
`;
    const diags = wgc301.check(makeCtx(yaml));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("WGC301");
    expect(diags[0].severity).toBe("info");
  });

  test("no diagnostic when IAMAuditConfig present", () => {
    const yaml = `apiVersion: iam.cnrm.cloud.google.com/v1beta1
kind: IAMAuditConfig
metadata:
  name: audit-config
spec:
  service: allServices
  auditLogConfigs:
    - logType: ADMIN_READ
    - logType: DATA_READ
`;
    const diags = wgc301.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
