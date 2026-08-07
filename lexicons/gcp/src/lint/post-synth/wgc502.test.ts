import { describe, test, expect } from "vitest";
import { wgc502 } from "./wgc502";

function makeCtx(yaml: string) {
  return {
    outputs: new Map([["gcp", yaml]]),
  };
}

describe("WGC502: org policy guardrail defines no rules", () => {
  test("flags a policy with no rules", () => {
    const yaml = `apiVersion: orgpolicy.cnrm.cloud.google.com/v1beta1
kind: OrgPolicyPolicy
metadata:
  name: hollow-guardrail
spec:
  resourceID: iam.disableServiceAccountKeyCreation
  organizationRef:
    external: "123456789012"
`;
    const diags = wgc502.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WGC502");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].entity).toBe("hollow-guardrail");
  });

  test("flags an empty rules array", () => {
    const yaml = `apiVersion: orgpolicy.cnrm.cloud.google.com/v1beta1
kind: OrgPolicyPolicy
metadata:
  name: empty-rules
spec:
  spec:
    rules: []
`;
    expect(wgc502.check(makeCtx(yaml))).toHaveLength(1);
  });

  test("no diagnostic when rules exist or the policy resets to default", () => {
    const yaml = `apiVersion: orgpolicy.cnrm.cloud.google.com/v1beta1
kind: OrgPolicyPolicy
metadata:
  name: enforced
spec:
  spec:
    rules:
      - enforce: "TRUE"
---
apiVersion: orgpolicy.cnrm.cloud.google.com/v1beta1
kind: OrgPolicyPolicy
metadata:
  name: reset-policy
spec:
  spec:
    reset: true
`;
    expect(wgc502.check(makeCtx(yaml))).toHaveLength(0);
  });
});
