import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { wgc503 } from "./wgc503";

function makeCtx(yaml: string): PostSynthContext {
  const outputs = new Map<string, string>([["gcp", yaml]]);
  return {
    outputs,
    entities: new Map(),
    buildResult: { outputs, entities: new Map(), warnings: [], errors: [], sourceFileCount: 0 },
  };
}

describe("WGC503: audit logging dropped or scoped down", () => {
  test("flags an IAMAuditConfig with no auditLogConfigs", () => {
    const yaml = `apiVersion: iam.cnrm.cloud.google.com/v1beta1
kind: IAMAuditConfig
metadata:
  name: audit-config
spec:
  resourceRef:
    kind: Organization
    external: organizations/123456789012
  service: allServices
`;
    const diags = wgc503.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WGC503");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toContain("captures nothing");
  });

  test("flags exempted members", () => {
    const yaml = `apiVersion: iam.cnrm.cloud.google.com/v1beta1
kind: IAMAuditConfig
metadata:
  name: audit-config
spec:
  service: allServices
  auditLogConfigs:
    - logType: ADMIN_READ
    - logType: DATA_WRITE
      exemptedMembers:
        - user:cto@acme.dev
`;
    const diags = wgc503.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("DATA_WRITE");
    expect(diags[0].message).toContain("exempts");
  });

  test("no diagnostic for full coverage without exemptions", () => {
    const yaml = `apiVersion: iam.cnrm.cloud.google.com/v1beta1
kind: IAMAuditConfig
metadata:
  name: audit-config
spec:
  service: allServices
  auditLogConfigs:
    - logType: ADMIN_READ
    - logType: DATA_READ
    - logType: DATA_WRITE
`;
    expect(wgc503.check(makeCtx(yaml))).toHaveLength(0);
  });

  test("ignores other kinds", () => {
    const yaml = `apiVersion: storage.cnrm.cloud.google.com/v1beta1
kind: StorageBucket
metadata:
  name: my-bucket
spec:
  location: US
`;
    expect(wgc503.check(makeCtx(yaml))).toHaveLength(0);
  });
});
