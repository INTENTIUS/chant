import { describe, test, expect } from "bun:test";
import { CFGenerator } from "./generator";
import type { TemplateIR } from "@intentius/chant/import/parser";

describe("CFGenerator", () => {
  const generator = new CFGenerator();

  test("generates empty template", () => {
    const ir: TemplateIR = {
      parameters: [],
      resources: [],
    };

    const files = generator.generate(ir);

    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("main.ts");
  });

  test("generates S3 Bucket", () => {
    const ir: TemplateIR = {
      parameters: [],
      resources: [
        {
          logicalId: "MyBucket",
          type: "AWS::S3::Bucket",
          properties: {
            BucketName: "my-bucket",
          },
        },
      ],
    };

    const files = generator.generate(ir);

    expect(files[0].content).toContain("import { Bucket }");
    expect(files[0].content).toContain("export const MyBucket = new Bucket({");
    expect(files[0].content).toContain('bucketName: "my-bucket"');
  });

  test("generates Lambda Function", () => {
    const ir: TemplateIR = {
      parameters: [],
      resources: [
        {
          logicalId: "MyFunction",
          type: "AWS::Lambda::Function",
          properties: {
            FunctionName: "my-function",
            Runtime: "nodejs18.x",
            Handler: "index.handler",
          },
        },
      ],
    };

    const files = generator.generate(ir);

    expect(files[0].content).toContain("import { Function }");
    expect(files[0].content).toContain("export const MyFunction = new Function({");
    expect(files[0].content).toContain('functionName: "my-function"');
    expect(files[0].content).toContain('runtime: "nodejs18.x"');
  });

  test("generates Ref as variable reference", () => {
    const ir: TemplateIR = {
      parameters: [{ name: "BucketName", type: "String" }],
      resources: [
        {
          logicalId: "MyBucket",
          type: "AWS::S3::Bucket",
          properties: {
            BucketName: { __intrinsic: "Ref", name: "BucketName" },
          },
        },
      ],
    };

    const files = generator.generate(ir);

    expect(files[0].content).toContain("bucketName: Ref(BucketName)");
  });

  test("generates GetAtt as property access", () => {
    const ir: TemplateIR = {
      parameters: [],
      resources: [
        {
          logicalId: "SourceBucket",
          type: "AWS::S3::Bucket",
          properties: {},
        },
        {
          logicalId: "DestBucket",
          type: "AWS::S3::Bucket",
          properties: {
            SourceArn: { __intrinsic: "GetAtt", logicalId: "SourceBucket", attribute: "Arn" },
          },
        },
      ],
    };

    const files = generator.generate(ir);

    expect(files[0].content).toContain("sourceArn: SourceBucket.arn");
  });

  test("generates Sub as tagged template", () => {
    const ir: TemplateIR = {
      parameters: [],
      resources: [
        {
          logicalId: "MyBucket",
          type: "AWS::S3::Bucket",
          properties: {
            BucketName: { __intrinsic: "Sub", template: "${AWS::StackName}-bucket" },
          },
        },
      ],
    };

    const files = generator.generate(ir);

    expect(files[0].content).toContain("Sub");
    expect(files[0].content).toContain("AWS.StackName");
  });

  test("generates If intrinsic", () => {
    const ir: TemplateIR = {
      parameters: [],
      resources: [
        {
          logicalId: "MyBucket",
          type: "AWS::S3::Bucket",
          properties: {
            BucketName: {
              __intrinsic: "If",
              condition: "CreateProd",
              valueIfTrue: "prod-bucket",
              valueIfFalse: "dev-bucket",
            },
          },
        },
      ],
    };

    const files = generator.generate(ir);

    expect(files[0].content).toContain('If("CreateProd"');
    expect(files[0].content).toContain('"prod-bucket"');
    expect(files[0].content).toContain('"dev-bucket"');
  });

  test("orders resources by dependencies", () => {
    const ir: TemplateIR = {
      parameters: [],
      resources: [
        {
          logicalId: "DependentBucket",
          type: "AWS::S3::Bucket",
          properties: {
            SourceArn: { __intrinsic: "GetAtt", logicalId: "SourceBucket", attribute: "Arn" },
          },
        },
        {
          logicalId: "SourceBucket",
          type: "AWS::S3::Bucket",
          properties: {},
        },
      ],
    };

    const files = generator.generate(ir);
    const content = files[0].content;

    const sourcePos = content.indexOf("SourceBucket");
    const depPos = content.indexOf("DependentBucket");

    expect(sourcePos).toBeLessThan(depPos);
  });
});
