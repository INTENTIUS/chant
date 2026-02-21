import { describe, test, expect } from "bun:test";
import { awsSerializer } from "./serializer";
import { Sub, If, Join, AWS } from "./index";
import { Bucket, Function, Role } from "./generated/index";
import { DECLARABLE_MARKER, type Declarable } from "@intentius/chant/declarable";

describe("AWS Integration", () => {
  describe("Serializer", () => {
    test("produces valid CF JSON structure", () => {
      const entities = new Map<string, Declarable>();
      const output = awsSerializer.serialize(entities);
      const template = JSON.parse(output);

      expect(template.AWSTemplateFormatVersion).toBe("2010-09-09");
      expect(template.Resources).toBeDefined();
    });

    test("serializes S3 bucket with properties", () => {
      const bucket = new (Bucket as any)({
        BucketName: "my-bucket",
      });

      const entities = new Map<string, Declarable>();
      entities.set("MyBucket", bucket);

      const output = awsSerializer.serialize(entities);
      const template = JSON.parse(output);

      expect(template.Resources.MyBucket.Type).toBe("AWS::S3::Bucket");
      expect(template.Resources.MyBucket.Properties.BucketName).toBe("my-bucket");
    });
  });

  describe("Intrinsics", () => {
    test("Sub with pseudo-parameters", () => {
      const result = Sub`${AWS.StackName}-bucket`;
      expect(result.toJSON()).toEqual({ "Fn::Sub": "${AWS::StackName}-bucket" });
    });

    test("Sub with multiple interpolations", () => {
      const result = Sub`${AWS.StackName}-${AWS.Region}-bucket`;
      expect(result.toJSON()).toEqual({
        "Fn::Sub": "${AWS::StackName}-${AWS::Region}-bucket",
      });
    });

    test("If with string values", () => {
      const result = If("IsProduction", "prod-bucket", "dev-bucket");
      expect(result.toJSON()).toEqual({
        "Fn::If": ["IsProduction", "prod-bucket", "dev-bucket"],
      });
    });

    test("Join with array", () => {
      const result = Join("-", ["my", "bucket", "name"]);
      expect(result.toJSON()).toEqual({
        "Fn::Join": ["-", ["my", "bucket", "name"]],
      });
    });
  });

  describe("Cross-resource references", () => {
    test("GetAtt for bucket ARN", () => {
      const bucket = new (Bucket as any)({ BucketName: "source" });
      // Set logical name for the AttrRef
      (bucket.Arn as Record<string, unknown>)._setLogicalName("SourceBucket");

      expect(bucket.Arn.getLogicalName()).toBe("SourceBucket");
      expect(bucket.Arn.attribute).toBe("Arn");
    });
  });

  describe("Resource types", () => {
    test("Bucket has correct entity type", () => {
      const bucket = new (Bucket as any)({});
      expect(bucket.entityType).toBe("AWS::S3::Bucket");
      expect(bucket[DECLARABLE_MARKER]).toBe(true);
    });

    test("Lambda Function has correct entity type", () => {
      const fn = new (Function as any)({
        Runtime: "nodejs18.x",
        Handler: "index.handler",
        Code: { S3Bucket: "my-bucket", S3Key: "code.zip" },
        Role: "arn:aws:iam::123456789012:role/lambda-role",
      });
      expect(fn.entityType).toBe("AWS::Lambda::Function");
      expect(fn[DECLARABLE_MARKER]).toBe(true);
    });

    test("IAM Role has correct entity type", () => {
      const role = new (Role as any)({
        AssumeRolePolicyDocument: {
          Version: "2012-10-17",
          Statement: [],
        },
      });
      expect(role.entityType).toBe("AWS::IAM::Role");
      expect(role[DECLARABLE_MARKER]).toBe(true);
    });
  });

  describe("AttrRefs", () => {
    test("Bucket has expected AttrRefs", () => {
      const bucket = new (Bucket as any)({});
      expect(bucket.Arn).toBeDefined();
      expect(bucket.DomainName).toBeDefined();
      expect(bucket.WebsiteURL).toBeDefined();
    });

    test("Lambda Function has expected AttrRefs", () => {
      const fn = new (Function as any)({
        Runtime: "nodejs18.x",
        Handler: "index.handler",
        Code: { S3Bucket: "bucket", S3Key: "key" },
        Role: "role-arn",
      });
      expect(fn.Arn).toBeDefined();
    });

    test("IAM Role has expected AttrRefs", () => {
      const role = new (Role as any)({
        AssumeRolePolicyDocument: {},
      });
      expect(role.Arn).toBeDefined();
      expect(role.RoleId).toBeDefined();
    });
  });
});
