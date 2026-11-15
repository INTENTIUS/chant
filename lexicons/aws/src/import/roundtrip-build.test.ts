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

describe("what import used to drop", () => {
  test("resource attributes come back: DependsOn, the policies, and Metadata with an intrinsic in it", async () => {
    const original = {
      Resources: {
        MyQueue: {
          Type: "AWS::SQS::Queue",
          DeletionPolicy: "Retain",
          UpdateReplacePolicy: "Retain",
          Metadata: { Note: { "Fn::Sub": "${AWS::StackName}-queue" } },
        },
        MyDB: {
          Type: "AWS::RDS::DBInstance",
          DependsOn: ["MyQueue", "MyGroup"],
          DeletionPolicy: "Snapshot",
          UpdateReplacePolicy: "Snapshot",
          Properties: { DBInstanceClass: "db.t3.micro", Engine: "mysql", StorageEncrypted: true, BackupRetentionPeriod: 7 },
        },
        MyGroup: {
          Type: "AWS::AutoScaling::AutoScalingGroup",
          DependsOn: "MyQueue",
          CreationPolicy: { ResourceSignal: { Count: 1, Timeout: "PT15M" } },
          UpdatePolicy: { AutoScalingRollingUpdate: { MinInstancesInService: 1 } },
          Properties: { MinSize: "1", MaxSize: "2", AvailabilityZones: ["us-east-1a"] },
        },
      },
    };
    const { template, source } = await roundTrip(JSON.stringify(original));
    expect(source).toContain("DependsOn: [MyQueue, MyGroup]");
    expect(template.Resources).toEqual(original.Resources);
  });

  test("the template's Description and Metadata come back", async () => {
    const original = {
      Description: "A queue",
      Metadata: { "cfn-lint": { config: { ignore_checks: ["W3005"] } }, Stack: { Ref: "AWS::StackName" } },
      Resources: { MyQueue: { Type: "AWS::SQS::Queue" } },
    };
    const ir = parser.parse(JSON.stringify(original));
    expect(ir.warnings).toBeUndefined();
    const { template } = await roundTrip(JSON.stringify(original));
    expect(template.Description).toBe(original.Description);
    expect(template.Metadata).toEqual(original.Metadata);
  });

  test("parameter constraints come back as written", async () => {
    const original = {
      Parameters: {
        Name: {
          Type: "String",
          AllowedPattern: "[a-z]+",
          ConstraintDescription: "lower case",
          MinLength: "1",
          MaxLength: 64,
          NoEcho: true,
        },
        Size: { Type: "Number", Default: 5, MinValue: 1, MaxValue: "10", AllowedValues: [1, 5, 10] },
      },
      Resources: { MyQueue: { Type: "AWS::SQS::Queue", Properties: { QueueName: { Ref: "Name" }, DelaySeconds: { Ref: "Size" } } } },
    };
    const { template } = await roundTrip(JSON.stringify(original));
    expect(template.Parameters).toEqual(original.Parameters);
  });

  test("Fn::Select of a list parameter selects from the list, and the index is kept as written", async () => {
    const original = {
      Parameters: { Subnets: { Type: "List<AWS::EC2::Subnet::Id>" } },
      Resources: {
        MyInstance: { Type: "AWS::EC2::Instance", Properties: { SubnetId: { "Fn::Select": [0, { Ref: "Subnets" }] } } },
        MyOther: {
          Type: "AWS::EC2::Instance",
          Properties: { SubnetId: { "Fn::Select": ["1", { Ref: "Subnets" }] }, AvailabilityZone: { "Fn::Select": [0, { "Fn::GetAZs": "" }] } },
        },
      },
    };
    const { template } = await roundTrip(JSON.stringify(original));
    expect(template.Resources).toEqual(original.Resources);
  });

  test("a logical id that is a class name keeps its name", async () => {
    const original = {
      Resources: {
        InternetGateway: { Type: "AWS::EC2::InternetGateway" },
        Attachment: {
          Type: "AWS::EC2::VPCGatewayAttachment",
          Properties: { InternetGatewayId: { Ref: "InternetGateway" }, VpcId: "vpc-1" },
        },
      },
    };
    const { template, source } = await roundTrip(JSON.stringify(original));
    expect(source).toContain("InternetGateway as InternetGatewayResource");
    expect(template.Resources).toEqual(original.Resources);
  });
});

describe("one name in two CloudFormation namespaces", () => {
  test("an output named like a parameter or a resource, and a condition named like a parameter, come back under their names", async () => {
    const original = {
      Parameters: {
        QueueName: { Type: "String" },
        EnableReplica: { Type: "String", Default: "false" },
      },
      Conditions: {
        EnableReplica: { "Fn::Equals": [{ Ref: "EnableReplica" }, "true"] },
      },
      Resources: {
        MyQueue: { Type: "AWS::SQS::Queue", Properties: { QueueName: { Ref: "QueueName" } } },
        Replica: {
          Type: "AWS::SQS::Queue",
          Condition: "EnableReplica",
          Properties: { DelaySeconds: { "Fn::If": ["EnableReplica", 5, 0] } },
        },
      },
      Outputs: {
        QueueName: { Value: { "Fn::GetAtt": ["MyQueue", "QueueName"] } },
        MyQueue: { Value: { Ref: "MyQueue" }, Condition: "EnableReplica" },
      },
    };
    const { template, source } = await roundTrip(JSON.stringify(original));
    expect(source).toContain('export const EnableReplicaCondition = new Condition(');
    expect(source).toContain('name: "EnableReplica" })');
    expect(source).toContain("export const QueueNameOutput = stackOutput(");
    expect(source).toContain("export const MyQueueOutput = stackOutput(");
    expect(template.Parameters).toEqual(original.Parameters);
    expect(template.Conditions).toEqual(original.Conditions);
    expect(template.Resources).toEqual(original.Resources);
    expect(template.Outputs).toEqual(original.Outputs);
  });
});

describe("Mappings and Fn::FindInMap", () => {
  test("a template's Mappings, and FindInMap reads of them, come back", async () => {
    const original = {
      Parameters: { InstanceType: { Type: "String", Default: "t3.micro" } },
      Mappings: {
        RegionMap: { "us-east-1": { AZs: ["us-east-1a", "us-east-1b"] } },
        TypeArch: { "t3.micro": { Arch: "HVM64" } },
        ArchAmi: { "us-east-1": { HVM64: "ami-123" } },
      },
      Resources: {
        MySubnet: {
          Type: "AWS::EC2::Subnet",
          Properties: {
            VpcId: "vpc-1",
            CidrBlock: { "Fn::Select": [0, { "Fn::Cidr": ["10.0.0.0/16", 4, 8] }] },
            AvailabilityZone: { "Fn::Select": [0, { "Fn::FindInMap": ["RegionMap", { Ref: "AWS::Region" }, "AZs"] }] },
          },
        },
        MyInstance: {
          Type: "AWS::EC2::Instance",
          Properties: {
            ImageId: {
              "Fn::FindInMap": ["ArchAmi", { Ref: "AWS::Region" }, { "Fn::FindInMap": ["TypeArch", { Ref: "InstanceType" }, "Arch"] }],
            },
            SubnetId: { "Fn::ImportValue": { "Fn::Sub": "${AWS::StackName}-SubnetId" } },
          },
        },
      },
    };
    const ir = parser.parse(JSON.stringify(original));
    expect(ir.warnings).toBeUndefined();
    const { template, source } = await roundTrip(JSON.stringify(original));
    expect(source).toContain("export const RegionMap = new Mapping(");
    expect(source).toContain('FindInMap(ArchAmi, AWS.Region, FindInMap(TypeArch, Ref(InstanceType), "Arch"))');
    expect(template.Mappings).toEqual(original.Mappings);
    expect(template.Resources).toEqual(original.Resources);
  });

  test("a mapping named like a resource keeps its name", async () => {
    const original = {
      Mappings: { Config: { a: { b: "queue-name" } } },
      Resources: {
        Config: { Type: "AWS::SQS::Queue", Properties: { QueueName: { "Fn::FindInMap": ["Config", "a", "b"] } } },
      },
    };
    const { template, source } = await roundTrip(JSON.stringify(original));
    expect(source).toContain('export const ConfigMapping = new Mapping(');
    expect(template.Mappings).toEqual(original.Mappings);
    expect(template.Resources).toEqual(original.Resources);
  });

  test("an intrinsic import cannot write is refused at import, not written as an object", () => {
    const original = {
      Resources: {
        MyQueue: { Type: "AWS::SQS::Queue", Properties: { Tags: { "Fn::Transform": { Name: "AWS::Include", Parameters: {} } } } },
      },
    };
    expect(() => generator.generate(parser.parse(JSON.stringify(original)))).toThrow(/cannot generate Fn::Transform/);
  });
});

describe("YAML dates (#5076)", () => {
  const policy = `Resources:
  Role:
    Type: AWS::IAM::Role
    Properties:
      AssumeRolePolicyDocument:
        Version: 2012-10-17
        Statement:
          - Effect: Allow
            Principal:
              Service: ec2.amazonaws.com
            Action: sts:AssumeRole
      Policies:
        - PolicyName: read
          PolicyDocument:
            Version: 2012-10-17
            Statement:
              - Effect: Allow
                Action: s3:GetObject
                Resource: !Sub "arn:aws:s3:::\${Bucket}/*"
  Bucket:
    Type: AWS::S3::Bucket
    Properties:
      BucketName: !Sub
        - "logs-\${Day}"
        - Day: 2024-01-15
`;

  test("an unquoted Version: 2012-10-17 builds as the string, not {}", async () => {
    const { template, source } = await roundTrip(policy);
    expect(source).toContain('Version: "2012-10-17"');
    const props = template.Resources.Role.Properties;
    expect(props.AssumeRolePolicyDocument.Version).toBe("2012-10-17");
    expect(props.Policies[0].PolicyDocument.Version).toBe("2012-10-17");
  });

  test("a date inside an Fn::Sub variable map is substituted as written", async () => {
    const { template } = await roundTrip(policy);
    expect(template.Resources.Bucket.Properties.BucketName).toEqual({ "Fn::Sub": "logs-2024-01-15" });
  });

  test("a date or timestamp as a parameter default, mapping value and output builds as written", async () => {
    const { template } = await roundTrip(`AWSTemplateFormatVersion: 2010-09-09
Parameters:
  Since:
    Type: String
    Default: 2001-12-14t21:59:43.10-05:00
Mappings:
  Releases:
    stable:
      Date: 2024-01-15
Resources:
  Queue:
    Type: AWS::SQS::Queue
    Properties:
      QueueName: q
Outputs:
  Stamp:
    Value: 2024-01-15 10:00:00
`);
    expect(template.Parameters.Since.Default).toBe("2001-12-14t21:59:43.10-05:00");
    expect(template.Mappings.Releases.stable.Date).toBe("2024-01-15");
    expect(template.Outputs.Stamp.Value).toBe("2024-01-15 10:00:00");
  });
});
