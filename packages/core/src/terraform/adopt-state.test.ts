import { describe, test, expect } from "vitest";
import { adoptFromState, canAdoptFromState } from "./adopt-state";
import type { StateResource } from "./state";

describe("adoptFromState", () => {
  test("maps a real S3 bucket state resource to native chant source", () => {
    const resource: StateResource = {
      type: "aws_s3_bucket",
      name: "assets",
      attributes: {
        id: "myapp-assets-prod",
        bucket: "myapp-assets-prod",
        arn: "arn:aws:s3:::myapp-assets-prod",
        tags: { Team: "web", Env: "prod" },
        force_destroy: false,
      },
    };
    const out = adoptFromState(resource)!;
    expect(out.fileName).toBe("assets.ts");
    expect(out.mapped).toBe(true);
    expect(out.nativeType).toBe("AWS::S3::Bucket");

    // Correct constructor + CloudFormation PascalCase props from real TF attrs.
    expect(out.content).toContain('import { Bucket } from "@intentius/chant-lexicon-aws";');
    expect(out.content).toContain("export const assets = new Bucket({");
    expect(out.content).toContain('BucketName: "myapp-assets-prod"');
    expect(out.content).toContain('{"Key":"Team","Value":"web"}');
    expect(out.content).toContain('{"Key":"Env","Value":"prod"}');

    // Unmapped attributes are preserved for reconciliation, not dropped.
    expect(out.content).toContain("Unmapped Terraform attributes");
    expect(out.content).toContain("force_destroy");
    // Mapped keys are not repeated in the unmapped block.
    expect(out.content).not.toContain('"bucket":');
  });

  test("maps a log group with retention", () => {
    const out = adoptFromState({
      type: "aws_cloudwatch_log_group",
      name: "api",
      attributes: { id: "/myapp/api", name: "/myapp/api", retention_in_days: 30, arn: "arn:...:log-group:/myapp/api" },
    })!;
    expect(out.content).toContain("new LogsLogGroup({");
    expect(out.content).toContain('LogGroupName: "/myapp/api"');
    expect(out.content).toContain("RetentionInDays: 30");
  });

  test("canAdoptFromState gates on a known native constructor", () => {
    expect(canAdoptFromState("aws_s3_bucket")).toBe(true);
    expect(canAdoptFromState("random_pet")).toBe(false);
  });

  test("returns null for a type with no native constructor", () => {
    expect(adoptFromState({ type: "random_pet", name: "x", attributes: { id: "abc" } })).toBeNull();
  });
});
