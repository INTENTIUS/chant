import { describe, test, expect } from "bun:test";
import { wgc102 } from "./wgc102";

function makeCtx(yaml: string) {
  return {
    outputs: new Map([["gcp", yaml]]),
  };
}

describe("WGC102: public IAM in output", () => {
  test("flags allUsers in output", () => {
    const yaml = `apiVersion: iam.cnrm.cloud.google.com/v1beta1
kind: IAMPolicyMember
metadata:
  name: public-access
spec:
  member: allUsers
  role: roles/run.invoker
`;
    const diags = wgc102.check(makeCtx(yaml));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("WGC102");
    expect(diags[0].severity).toBe("warning");
  });

  test("no diagnostic when no public members", () => {
    const yaml = `apiVersion: iam.cnrm.cloud.google.com/v1beta1
kind: IAMPolicyMember
metadata:
  name: private-access
spec:
  member: serviceAccount:sa@project.iam.gserviceaccount.com
  role: roles/viewer
`;
    const diags = wgc102.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
