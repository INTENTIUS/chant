import { describe, test, expect } from "vitest";
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

describe("CFParser conditions and outputs (#2069)", () => {
  const parser = new CFParser();

  const template = JSON.stringify({
    AWSTemplateFormatVersion: "2010-09-09",
    Parameters: { Cutover: { Type: "String", Default: "false" } },
    Conditions: {
      DoCutover: { "Fn::Equals": [{ Ref: "Cutover" }, "true"] },
      NoCutover: { "Fn::Not": [{ Condition: "DoCutover" }] },
    },
    Resources: {
      Rule: {
        Type: "AWS::Logs::LogGroup",
        Condition: "DoCutover",
        Properties: { LogGroupName: { "Fn::If": ["DoCutover", "/on", "/off"] } },
      },
    },
    Outputs: {
      RuleName: { Condition: "DoCutover", Value: { Ref: "Rule" }, Description: "d", Export: { Name: "rule-name" } },
      Plain: { Value: "literal" },
    },
  });

  test("parses the Conditions section, Condition references included", () => {
    const ir = parser.parse(template);
    expect(ir.conditions).toHaveLength(2);
    expect(ir.conditions![0]).toEqual({
      name: "DoCutover",
      expression: { __intrinsic: "Equals", left: { __intrinsic: "Ref", name: "Cutover" }, right: "true" },
    });
    expect(ir.conditions![1]).toEqual({
      name: "NoCutover",
      expression: { __intrinsic: "Not", condition: { __intrinsic: "ConditionRef", name: "DoCutover" } },
    });
  });

  test("carries the resource-level Condition key", () => {
    const ir = parser.parse(template);
    expect(ir.resources[0].condition).toBe("DoCutover");
  });

  test("parses Outputs with Condition, Description, and Export", () => {
    const ir = parser.parse(template);
    expect(ir.outputs).toHaveLength(2);
    expect(ir.outputs![0]).toEqual({
      name: "RuleName",
      value: { __intrinsic: "Ref", name: "Rule" },
      description: "d",
      exportName: "rule-name",
      condition: "DoCutover",
    });
    expect(ir.outputs![1]).toEqual({
      name: "Plain",
      value: "literal",
      description: undefined,
      exportName: undefined,
      condition: undefined,
    });
  });

  test("a single-key Condition object in resource properties is NOT a condition reference", () => {
    const ir = parser.parse(
      JSON.stringify({
        Resources: {
          Role: {
            Type: "AWS::IAM::Role",
            Properties: {
              Policy: { Condition: "not-a-ref" },
            },
          },
        },
      }),
    );
    expect(ir.resources[0].properties.Policy).toEqual({ Condition: "not-a-ref" });
  });

  test("names sections import cannot carry instead of dropping them silently", () => {
    const ir = parser.parse(
      JSON.stringify({
        Resources: { R: { Type: "AWS::S3::Bucket" } },
        Mappings: { M: {} },
        Rules: { R1: {} },
      }),
    );
    expect(ir.warnings).toEqual([
      'Template section "Mappings" is not carried by import — it is dropped from the generated source',
      'Template section "Rules" is not carried by import — it is dropped from the generated source',
    ]);
  });

  test("no warnings for fully-carried templates", () => {
    const ir = parser.parse(template);
    expect(ir.warnings).toBeUndefined();
  });
});
