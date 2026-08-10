import { describe, test, expect } from "vitest";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { waw058, checkAuditTrailPosture } from "./waw058";

function makeCtx(template: object) {
  return createPostSynthContext({ aws: template });
}

function trail(props: object) {
  return { Type: "AWS::CloudTrail::Trail", Properties: props };
}

describe("WAW058: organization audit trail dropped or scoped down", () => {
  test("check metadata", () => {
    expect(waw058.id).toBe("WAW058");
    expect(waw058.description).toContain("audit");
  });

  test("flags a trail with IsLogging: false", () => {
    const ctx = makeCtx({
      Resources: { Trail: trail({ IsLogging: false, S3BucketName: "audit", IsMultiRegionTrail: true }) },
    });
    const diags = checkAuditTrailPosture(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW058");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toContain("IsLogging");
  });

  test("flags an organization trail that is not multi-region", () => {
    const single = makeCtx({
      Resources: {
        Trail: trail({ IsLogging: true, S3BucketName: "audit", IsOrganizationTrail: true, IsMultiRegionTrail: false }),
      },
    });
    expect(checkAuditTrailPosture(single)).toHaveLength(1);

    const unset = makeCtx({
      Resources: { Trail: trail({ IsLogging: true, S3BucketName: "audit", IsOrganizationTrail: true }) },
    });
    expect(checkAuditTrailPosture(unset)).toHaveLength(1);
  });

  test("flags an organization declared with no trail at all", () => {
    const ctx = makeCtx({
      Resources: { Org: { Type: "AWS::Organizations::Organization", Properties: { FeatureSet: "ALL" } } },
    });
    const diags = checkAuditTrailPosture(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("no CloudTrail trail");
  });

  test("no diagnostic for the OrganizationTrail composite shape", () => {
    const ctx = makeCtx({
      Resources: {
        Org: { Type: "AWS::Organizations::Organization", Properties: { FeatureSet: "ALL" } },
        Trail: trail({ IsLogging: true, S3BucketName: "audit", IsMultiRegionTrail: true, IsOrganizationTrail: true }),
      },
    });
    expect(checkAuditTrailPosture(ctx)).toHaveLength(0);
  });

  test("a non-organization trail may be single-region", () => {
    const ctx = makeCtx({
      Resources: { Trail: trail({ IsLogging: true, S3BucketName: "audit", IsMultiRegionTrail: false }) },
    });
    expect(checkAuditTrailPosture(ctx)).toHaveLength(0);
  });

  test("skips intrinsic IsLogging/IsMultiRegionTrail values", () => {
    const ctx = makeCtx({
      Resources: {
        Trail: trail({
          IsLogging: { Ref: "LoggingEnabled" },
          IsOrganizationTrail: true,
          IsMultiRegionTrail: { Ref: "MultiRegion" },
        }),
      },
    });
    expect(checkAuditTrailPosture(ctx)).toHaveLength(0);
  });
});
