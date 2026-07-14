import { describe, test, expect } from "vitest";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { waw053, checkEcrScanOnPush } from "./waw053";

function makeCtx(template: object) {
  return createPostSynthContext({ aws: template });
}

describe("WAW053: ECR Image Scanning Disabled", () => {
  test("check metadata", () => {
    expect(waw053.id).toBe("WAW053");
    expect(waw053.description).toContain("scan");
  });

  test("flags a repository with no ImageScanningConfiguration", () => {
    const ctx = makeCtx({
      Resources: { MyRepo: { Type: "AWS::ECR::Repository", Properties: { RepositoryName: "app" } } },
    });
    const diags = checkEcrScanOnPush(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW053");
  });

  test("flags ScanOnPush: false", () => {
    const ctx = makeCtx({
      Resources: {
        MyRepo: {
          Type: "AWS::ECR::Repository",
          Properties: { ImageScanningConfiguration: { ScanOnPush: false } },
        },
      },
    });
    expect(checkEcrScanOnPush(ctx)).toHaveLength(1);
  });

  test("no diagnostic when ScanOnPush: true", () => {
    const ctx = makeCtx({
      Resources: {
        MyRepo: {
          Type: "AWS::ECR::Repository",
          Properties: { ImageScanningConfiguration: { ScanOnPush: true } },
        },
      },
    });
    expect(checkEcrScanOnPush(ctx)).toHaveLength(0);
  });

  test("skips intrinsic ImageScanningConfiguration/ScanOnPush values", () => {
    const ctx = makeCtx({
      Resources: { MyRepo: { Type: "AWS::ECR::Repository", Properties: { ImageScanningConfiguration: { Ref: "ScanParam" } } } },
    });
    expect(checkEcrScanOnPush(ctx)).toHaveLength(0);
  });

  test("no diagnostic for non-ECR resources", () => {
    const ctx = makeCtx({ Resources: { MyBucket: { Type: "AWS::S3::Bucket", Properties: {} } } });
    expect(checkEcrScanOnPush(ctx)).toHaveLength(0);
  });
});
