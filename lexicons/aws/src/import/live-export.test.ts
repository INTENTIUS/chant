import { describe, expect, test } from "vitest";
import { parseStackTemplate } from "./live-export";
import { CFGenerator } from "./generator";

// Mimics what `aws cloudformation get-template --output json` returns:
// a JSON object under TemplateBody.
const liveTemplate = {
  AWSTemplateFormatVersion: "2010-09-09",
  Resources: {
    MyBucket: {
      Type: "AWS::S3::Bucket",
      Properties: { BucketName: "my-bucket", VersioningConfiguration: { Status: "Enabled" } },
    },
    MyQueue: {
      Type: "AWS::SQS::Queue",
      Properties: { QueueName: "my-queue" },
    },
  },
};

describe("AWS exportResources mapping (#115)", () => {
  test("maps a live CloudFormation template body to export IR", () => {
    const ir = parseStackTemplate(liveTemplate);
    expect(ir.resources.map((r) => r.logicalId).sort()).toEqual(["MyBucket", "MyQueue"]);
    const bucket = ir.resources.find((r) => r.logicalId === "MyBucket")!;
    expect(bucket.type).toBe("AWS::S3::Bucket");
    expect(bucket.properties.BucketName).toBe("my-bucket");
  });

  test("accepts a stringified template body (YAML-origin stacks)", () => {
    const ir = parseStackTemplate(JSON.stringify(liveTemplate));
    expect(ir.resources).toHaveLength(2);
  });

  test("selector by name narrows the export", () => {
    const ir = parseStackTemplate(liveTemplate, { name: "MyQueue" });
    expect(ir.resources.map((r) => r.logicalId)).toEqual(["MyQueue"]);
  });

  test("selector by type narrows the export", () => {
    const ir = parseStackTemplate(liveTemplate, { type: "AWS::S3::Bucket" });
    expect(ir.resources.map((r) => r.logicalId)).toEqual(["MyBucket"]);
  });

  test("export IR feeds CFGenerator (templateGenerator) unchanged", () => {
    const ir = parseStackTemplate(liveTemplate);
    const files = new CFGenerator().generate(ir);
    expect(files.length).toBeGreaterThan(0);
    const all = files.map((f) => f.content).join("\n");
    // CFGenerator emits chant TypeScript (constructors), not raw CFN type strings.
    expect(all).toContain("new Bucket(");
    expect(all).toContain("BucketName");
  });
});
