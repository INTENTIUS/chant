import { describe, test, expect } from "vitest";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { waw062, checkDuplicateNamesAndExports } from "./waw062";

function makeCtx(template: object) {
  return createPostSynthContext({ aws: template });
}

describe("WAW062: Duplicate Name Or Export Within A Template", () => {
  test("check metadata", () => {
    expect(waw062.id).toBe("WAW062");
    expect(waw062.description.toLowerCase()).toContain("duplicate");
  });

  test("duplicate Export Name → error", () => {
    const ctx = makeCtx({
      Resources: {
        MyBucket: { Type: "AWS::S3::Bucket", Properties: {} },
      },
      Outputs: {
        BucketArnA: { Value: { "Fn::GetAtt": ["MyBucket", "Arn"] }, Export: { Name: "shared-bucket-arn" } },
        BucketArnB: { Value: { "Fn::GetAtt": ["MyBucket", "Arn"] }, Export: { Name: "shared-bucket-arn" } },
      },
    });
    const diags = checkDuplicateNamesAndExports(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW062");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toContain("shared-bucket-arn");
    expect(diags[0].message).toContain("BucketArnA");
    expect(diags[0].message).toContain("BucketArnB");
    expect(diags[0].lexicon).toBe("aws");
  });

  test("unique Export Names → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {},
      Outputs: {
        A: { Value: "a", Export: { Name: "export-a" } },
        B: { Value: "b", Export: { Name: "export-b" } },
      },
    });
    expect(checkDuplicateNamesAndExports(ctx)).toHaveLength(0);
  });

  test("duplicate ECR RepositoryName across two composites → error", () => {
    const ctx = makeCtx({
      Resources: {
        RepoOne: { Type: "AWS::ECR::Repository", Properties: { RepositoryName: "svc-images" } },
        RepoTwo: { Type: "AWS::ECR::Repository", Properties: { RepositoryName: "svc-images" } },
      },
    });
    const diags = checkDuplicateNamesAndExports(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("svc-images");
    expect(diags[0].message).toContain("RepoOne");
    expect(diags[0].message).toContain("RepoTwo");
  });

  test("duplicate LaunchTemplateName → error", () => {
    const ctx = makeCtx({
      Resources: {
        LtA: { Type: "AWS::EC2::LaunchTemplate", Properties: { LaunchTemplateName: "worker-lt" } },
        LtB: { Type: "AWS::EC2::LaunchTemplate", Properties: { LaunchTemplateName: "worker-lt" } },
      },
    });
    expect(checkDuplicateNamesAndExports(ctx)).toHaveLength(1);
  });

  test("duplicate SecurityGroup GroupName → error", () => {
    const ctx = makeCtx({
      Resources: {
        SgA: { Type: "AWS::EC2::SecurityGroup", Properties: { GroupName: "web-sg", GroupDescription: "a" } },
        SgB: { Type: "AWS::EC2::SecurityGroup", Properties: { GroupName: "web-sg", GroupDescription: "b" } },
      },
    });
    expect(checkDuplicateNamesAndExports(ctx)).toHaveLength(1);
  });

  test("same literal name across different resource types → no diagnostic (not comparable)", () => {
    const ctx = makeCtx({
      Resources: {
        RepoOne: { Type: "AWS::ECR::Repository", Properties: { RepositoryName: "shared" } },
        TableOne: { Type: "AWS::DynamoDB::Table", Properties: { TableName: "shared" } },
      },
    });
    expect(checkDuplicateNamesAndExports(ctx)).toHaveLength(0);
  });

  test("intrinsic explicit names → no diagnostic (unprovable)", () => {
    const ctx = makeCtx({
      Resources: {
        RepoOne: { Type: "AWS::ECR::Repository", Properties: { RepositoryName: { "Fn::Sub": "svc-${AWS::StackName}" } } },
        RepoTwo: { Type: "AWS::ECR::Repository", Properties: { RepositoryName: { "Fn::Sub": "svc-${AWS::StackName}" } } },
      },
    });
    expect(checkDuplicateNamesAndExports(ctx)).toHaveLength(0);
  });

  test("distinct explicit names → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        RepoOne: { Type: "AWS::ECR::Repository", Properties: { RepositoryName: "svc-images-a" } },
        RepoTwo: { Type: "AWS::ECR::Repository", Properties: { RepositoryName: "svc-images-b" } },
      },
    });
    expect(checkDuplicateNamesAndExports(ctx)).toHaveLength(0);
  });
});
