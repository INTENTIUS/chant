/**
 * Import, then build the generated source, then compare with the template
 * imported. Each case is a shape from a real template that did not come back.
 */
import { describe, test, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { CFParser } from "./parser";
import { CFGenerator } from "./generator";
import { build } from "@intentius/chant/build";
import { generateOrganizedFiles } from "@intentius/chant/cli/commands/import";
import { awsSerializer } from "../serializer";

const parser = new CFParser();
const generator = new CFGenerator();

/** Import `content` with the layout `chant import` uses, build what it wrote, and return the built template. */
async function roundTrip(content: string): Promise<{ template: Record<string, any>; source: string }> {
  const { files } = generateOrganizedFiles(parser.parse(content), generator);
  expect(files.map((f) => f.path)).toEqual(["main.ts"]);
  const source = files[0].content;
  const dir = mkdtempSync(join(import.meta.dirname, "../../.roundtrip-tmp-"));
  try {
    const srcDir = join(dir, "src");
    mkdirSync(srcDir);
    writeFileSync(join(srcDir, "main.ts"), source);
    const result = await build(srcDir, [awsSerializer]);
    expect(result.errors.map((e) => e.message)).toEqual([]);
    return { template: JSON.parse(result.outputs.get("aws") as string), source };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("import layout", () => {
  test("the generator writes the whole template to one main.ts", () => {
    expect(generator.ownsLayout).toBe(true);
  });

  test("a template of more than three resources across categories builds from one file", async () => {
    const original = {
      Parameters: { AppName: { Type: "String" } },
      Resources: {
        MyCluster: { Type: "AWS::ECS::Cluster", Properties: { ClusterName: { Ref: "AppName" } } },
        MyBucket: { Type: "AWS::S3::Bucket", Properties: { BucketName: { Ref: "AppName" } } },
        MyQueue: { Type: "AWS::SQS::Queue", Properties: { QueueName: { Ref: "AppName" } } },
        MyTopic: { Type: "AWS::SNS::Topic", Properties: { TopicName: { "Fn::GetAtt": ["MyQueue", "Arn"] } } },
      },
    };
    const { template } = await roundTrip(JSON.stringify(original));
    expect(template.Resources).toEqual(original.Resources);
  });
});

describe("Fn::Sub", () => {
  test("a bare ${Name} of a parameter or resource, and a ${!Literal}, come back as written", async () => {
    const sub = "${Env}-${MyBucket}-${MyBucket.Arn}-${AWS::Region}-${!Literal}";
    const original = {
      Parameters: { Env: { Type: "String" } },
      Resources: {
        MyBucket: { Type: "AWS::S3::Bucket" },
        MyQueue: { Type: "AWS::SQS::Queue", Properties: { QueueName: { "Fn::Sub": sub } } },
      },
    };
    const { template, source } = await roundTrip(JSON.stringify(original));
    expect(source).toContain("${Ref(Env)}-${Ref(MyBucket)}-${MyBucket.Arn}");
    expect(template.Resources.MyQueue.Properties.QueueName).toEqual({ "Fn::Sub": sub });
  });

  test("a dotted name the class does not expose stays a ${Id.Attr} reference", async () => {
    const sub = "queue ${MyQueue.QueueName}";
    const original = {
      Resources: {
        MyQueue: { Type: "AWS::SQS::Queue" },
        MyTopic: { Type: "AWS::SNS::Topic", Properties: { DisplayName: { "Fn::Sub": sub } } },
      },
    };
    const { template } = await roundTrip(JSON.stringify(original));
    expect(template.Resources.MyTopic.Properties.DisplayName).toEqual({ "Fn::Sub": sub });
  });
});

describe("Fn::GetAtt", () => {
  test("an attribute the class does not list is written by name, and the output keeps it", async () => {
    const original = {
      Resources: {
        MyQueue: { Type: "AWS::SQS::Queue" },
        MyTopic: { Type: "AWS::SNS::Topic", Properties: { DisplayName: { "Fn::GetAtt": ["MyQueue", "QueueName"] } } },
      },
      Outputs: {
        Name: { Value: { "Fn::GetAtt": ["MyQueue", "QueueName"] } },
        Arn: { Value: { "Fn::GetAtt": ["MyQueue", "Arn"] } },
      },
    };
    const { template, source } = await roundTrip(JSON.stringify(original));
    expect(source).toContain('GetAtt("MyQueue", "QueueName")');
    expect(template.Resources.MyTopic.Properties).toEqual(original.Resources.MyTopic.Properties);
    expect(template.Outputs).toEqual(original.Outputs);
  });

  test("YAML !GetAtt Db.Endpoint.Address names the attribute Endpoint.Address", async () => {
    const yaml = [
      "Resources:",
      "  MyDB:",
      "    Type: AWS::RDS::DBInstance",
      "    Properties:",
      "      DBInstanceClass: db.t3.micro",
      "      Engine: mysql",
      "      StorageEncrypted: true",
      "      BackupRetentionPeriod: 7",
      "Outputs:",
      "  Address:",
      "    Value: !Join ['', ['jdbc:mysql://', !GetAtt MyDB.Endpoint.Address, ':', !GetAtt MyDB.Endpoint.Port]]",
    ].join("\n");
    const ir = parser.parse(yaml);
    expect(ir.outputs?.[0].value).toMatchObject({
      values: [
        "jdbc:mysql://",
        { __intrinsic: "GetAtt", logicalId: "MyDB", attribute: "Endpoint.Address" },
        ":",
        { __intrinsic: "GetAtt", logicalId: "MyDB", attribute: "Endpoint.Port" },
      ],
    });
    const { template } = await roundTrip(yaml);
    expect(template.Outputs.Address.Value).toEqual({
      "Fn::Join": [
        "",
        ["jdbc:mysql://", { "Fn::GetAtt": ["MyDB", "Endpoint.Address"] }, ":", { "Fn::GetAtt": ["MyDB", "Endpoint.Port"] }],
      ],
    });
  });
});
