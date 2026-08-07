import { describe, test, expect } from "vitest";
import { wgc501 } from "./wgc501";

function makeCtx(yaml: string) {
  return {
    outputs: new Map([["gcp", yaml]]),
  };
}

describe("WGC501: org policy guardrail not enforced", () => {
  test("flags a rule with enforce disabled (serializer's nested spec.spec)", () => {
    const yaml = `apiVersion: orgpolicy.cnrm.cloud.google.com/v1beta1
kind: OrgPolicyPolicy
metadata:
  name: disable-sa-key-creation
spec:
  resourceID: iam.disableServiceAccountKeyCreation
  organizationRef:
    external: "123456789012"
  spec:
    rules:
      - enforce: "FALSE"
`;
    const diags = wgc501.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WGC501");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].entity).toBe("disable-sa-key-creation");
  });

  test("flags boolean false and flat spec.rules", () => {
    const yaml = `apiVersion: orgpolicy.cnrm.cloud.google.com/v1beta1
kind: OrgPolicyPolicy
metadata:
  name: skip-default-network
spec:
  rules:
    - enforce: false
`;
    expect(wgc501.check(makeCtx(yaml))).toHaveLength(1);
  });

  test("flags a policy that resets the constraint to default", () => {
    const yaml = `apiVersion: orgpolicy.cnrm.cloud.google.com/v1beta1
kind: OrgPolicyPolicy
metadata:
  name: reset-policy
spec:
  spec:
    reset: true
`;
    const diags = wgc501.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("reset");
  });

  test("no diagnostic for an enforced policy", () => {
    const yaml = `apiVersion: orgpolicy.cnrm.cloud.google.com/v1beta1
kind: OrgPolicyPolicy
metadata:
  name: disable-sa-key-creation
spec:
  spec:
    rules:
      - enforce: "TRUE"
      - values:
          allowedValues:
            - in:eu-locations
`;
    expect(wgc501.check(makeCtx(yaml))).toHaveLength(0);
  });

  test("ignores other kinds", () => {
    const yaml = `apiVersion: resourcemanager.cnrm.cloud.google.com/v1beta1
kind: ResourcemanagerFolder
metadata:
  name: security
spec:
  displayName: Security
`;
    expect(wgc501.check(makeCtx(yaml))).toHaveLength(0);
  });
});
