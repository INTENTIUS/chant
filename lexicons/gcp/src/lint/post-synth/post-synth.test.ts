import { describe, test, expect } from "bun:test";
import { wgc101 } from "./wgc101";
import { wgc102 } from "./wgc102";
import { wgc103 } from "./wgc103";
import { wgc104 } from "./wgc104";

function makeCtx(yaml: string) {
  return {
    outputs: new Map([["gcp", yaml]]),
  };
}

describe("WGC101: missing encryption", () => {
  test("flags StorageBucket without encryption", () => {
    const yaml = `apiVersion: storage.cnrm.cloud.google.com/v1beta1
kind: StorageBucket
metadata:
  name: my-bucket
spec:
  location: US
`;
    const diags = wgc101.check(makeCtx(yaml));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("WGC101");
  });
});

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
  });
});

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

describe("WGC104: missing uniform bucket access", () => {
  test("flags StorageBucket without uniformBucketLevelAccess", () => {
    const yaml = `apiVersion: storage.cnrm.cloud.google.com/v1beta1
kind: StorageBucket
metadata:
  name: my-bucket
spec:
  location: US
`;
    const diags = wgc104.check(makeCtx(yaml));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("WGC104");
  });
});
