import { describe, test, expect } from "bun:test";
import { CFParser } from "./parser";

describe("CFParser", () => {
  const parser = new CFParser();

  test("parses empty template", () => {
    const content = JSON.stringify({
      AWSTemplateFormatVersion: "2010-09-09",
      Resources: {},
    });

    const ir = parser.parse(content);

    expect(ir.parameters).toHaveLength(0);
    expect(ir.resources).toHaveLength(0);
    expect(ir.metadata?.version).toBe("2010-09-09");
  });

  test("parses parameters", () => {
    const content = JSON.stringify({
      AWSTemplateFormatVersion: "2010-09-09",
      Parameters: {
        Environment: {
          Type: "String",
          Description: "Environment name",
          Default: "dev",
        },
      },
      Resources: {},
    });

    const ir = parser.parse(content);

    expect(ir.parameters).toHaveLength(1);
    expect(ir.parameters[0].name).toBe("Environment");
    expect(ir.parameters[0].type).toBe("String");
    expect(ir.parameters[0].description).toBe("Environment name");
    expect(ir.parameters[0].defaultValue).toBe("dev");
  });

  test("parses S3 bucket resource", () => {
    const content = JSON.stringify({
      AWSTemplateFormatVersion: "2010-09-09",
      Resources: {
        MyBucket: {
          Type: "AWS::S3::Bucket",
          Properties: {
            BucketName: "my-bucket",
            VersioningConfiguration: {
              Status: "Enabled",
            },
          },
        },
      },
    });

    const ir = parser.parse(content);

    expect(ir.resources).toHaveLength(1);
    expect(ir.resources[0].logicalId).toBe("MyBucket");
    expect(ir.resources[0].type).toBe("AWS::S3::Bucket");
    expect(ir.resources[0].properties.BucketName).toBe("my-bucket");
  });

  test("parses Ref intrinsic", () => {
    const content = JSON.stringify({
      AWSTemplateFormatVersion: "2010-09-09",
      Parameters: {
        BucketName: { Type: "String" },
      },
      Resources: {
        MyBucket: {
          Type: "AWS::S3::Bucket",
          Properties: {
            BucketName: { Ref: "BucketName" },
          },
        },
      },
    });

    const ir = parser.parse(content);

    const nameProp = ir.resources[0].properties.BucketName as Record<string, unknown>;
    expect(nameProp.__intrinsic).toBe("Ref");
    expect(nameProp.name).toBe("BucketName");
  });

  test("parses Fn::GetAtt array form", () => {
    const content = JSON.stringify({
      AWSTemplateFormatVersion: "2010-09-09",
      Resources: {
        Source: { Type: "AWS::S3::Bucket", Properties: {} },
        Dest: {
          Type: "AWS::S3::Bucket",
          Properties: {
            SourceArn: { "Fn::GetAtt": ["Source", "Arn"] },
          },
        },
      },
    });

    const ir = parser.parse(content);

    const dest = ir.resources.find((r) => r.logicalId === "Dest");
    const prop = dest?.properties.SourceArn as Record<string, unknown>;
    expect(prop.__intrinsic).toBe("GetAtt");
    expect(prop.logicalId).toBe("Source");
    expect(prop.attribute).toBe("Arn");
  });

  test("parses Fn::Sub string form", () => {
    const content = JSON.stringify({
      AWSTemplateFormatVersion: "2010-09-09",
      Resources: {
        MyBucket: {
          Type: "AWS::S3::Bucket",
          Properties: {
            BucketName: { "Fn::Sub": "${AWS::StackName}-bucket" },
          },
        },
      },
    });

    const ir = parser.parse(content);

    const prop = ir.resources[0].properties.BucketName as Record<string, unknown>;
    expect(prop.__intrinsic).toBe("Sub");
    expect(prop.template).toBe("${AWS::StackName}-bucket");
  });

  test("parses Fn::If", () => {
    const content = JSON.stringify({
      AWSTemplateFormatVersion: "2010-09-09",
      Resources: {
        MyBucket: {
          Type: "AWS::S3::Bucket",
          Properties: {
            BucketName: {
              "Fn::If": ["CreateProd", "prod-bucket", "dev-bucket"],
            },
          },
        },
      },
    });

    const ir = parser.parse(content);

    const prop = ir.resources[0].properties.BucketName as Record<string, unknown>;
    expect(prop.__intrinsic).toBe("If");
    expect(prop.condition).toBe("CreateProd");
    expect(prop.valueIfTrue).toBe("prod-bucket");
    expect(prop.valueIfFalse).toBe("dev-bucket");
  });

  test("parses Fn::Join", () => {
    const content = JSON.stringify({
      AWSTemplateFormatVersion: "2010-09-09",
      Resources: {
        MyBucket: {
          Type: "AWS::S3::Bucket",
          Properties: {
            BucketName: { "Fn::Join": ["-", ["my", "bucket"]] },
          },
        },
      },
    });

    const ir = parser.parse(content);

    const prop = ir.resources[0].properties.BucketName as Record<string, unknown>;
    expect(prop.__intrinsic).toBe("Join");
    expect(prop.delimiter).toBe("-");
    expect(prop.values).toEqual(["my", "bucket"]);
  });

  test("parses nested properties", () => {
    const content = JSON.stringify({
      AWSTemplateFormatVersion: "2010-09-09",
      Resources: {
        MyFunction: {
          Type: "AWS::Lambda::Function",
          Properties: {
            Environment: {
              Variables: {
                KEY: "value",
              },
            },
          },
        },
      },
    });

    const ir = parser.parse(content);

    const env = ir.resources[0].properties.Environment as Record<string, unknown>;
    const vars = env.Variables as Record<string, unknown>;
    expect(vars.KEY).toBe("value");
  });
});
