import { describe, test, expect } from "bun:test";
import { awsSerializer } from "./serializer";
import { AttrRef } from "@intentius/chant/attrref";
import { DECLARABLE_MARKER, type Declarable } from "@intentius/chant/declarable";
import { LexiconOutput } from "@intentius/chant/lexicon-output";
import { Sub } from "./intrinsics";
import { AWS } from "./pseudo";
import { nestedStack, NestedStackOutputRef } from "./nested-stack";
import { stackOutput } from "@intentius/chant/stack-output";
import { createResource } from "@intentius/chant/runtime";
import type { SerializerResult } from "@intentius/chant/serializer";
import type { BuildResult } from "@intentius/chant/build";
import { Parameter } from "./parameter";

// Mock S3 Bucket for testing
class MockBucket implements Declarable {
  readonly [DECLARABLE_MARKER] = true as const;
  readonly lexicon = "aws";
  readonly entityType = "AWS::S3::Bucket";
  readonly arn: AttrRef;
  readonly props: { BucketName?: string; VersioningConfiguration?: { Status: string } };

  constructor(props: { BucketName?: string; VersioningConfiguration?: { Status: string } } = {}) {
    this.props = props;
    this.arn = new AttrRef(this, "Arn");
  }
}

describe("awsSerializer", () => {
  test("has correct name", () => {
    expect(awsSerializer.name).toBe("aws");
  });

  test("has correct rulePrefix", () => {
    expect(awsSerializer.rulePrefix).toBe("WAW");
  });
});

describe("awsSerializer.serialize", () => {
  test("produces valid CF template structure", () => {
    const entities = new Map<string, Declarable>();
    const output = awsSerializer.serialize(entities);
    const template = JSON.parse(output);

    expect(template.AWSTemplateFormatVersion).toBe("2010-09-09");
    expect(template.Resources).toBeDefined();
  });

  test("serializes empty entities", () => {
    const entities = new Map<string, Declarable>();
    const output = awsSerializer.serialize(entities);
    const template = JSON.parse(output);

    expect(template.Resources).toEqual({});
    expect(template.Parameters).toBeUndefined();
  });

  test("serializes resources", () => {
    const entities = new Map<string, Declarable>();
    entities.set("MyBucket", new MockBucket({ BucketName: "my-bucket" }));

    const output = awsSerializer.serialize(entities);
    const template = JSON.parse(output);

    expect(template.Resources.MyBucket).toBeDefined();
    expect(template.Resources.MyBucket.Type).toBe("AWS::S3::Bucket");
    expect(template.Resources.MyBucket.Properties.BucketName).toBe("my-bucket");
  });

  test("serializes parameters", () => {
    const entities = new Map<string, Declarable>();
    entities.set("Environment", new Parameter("String", {
      description: "Environment name",
      defaultValue: "dev",
    }));

    const output = awsSerializer.serialize(entities);
    const template = JSON.parse(output);

    expect(template.Parameters).toBeDefined();
    expect(template.Parameters.Environment.Type).toBe("String");
    expect(template.Parameters.Environment.Description).toBe("Environment name");
    expect(template.Parameters.Environment.Default).toBe("dev");
  });

  test("serializes nested properties", () => {
    const entities = new Map<string, Declarable>();
    entities.set("MyBucket", new MockBucket({
      BucketName: "my-bucket",
      VersioningConfiguration: { Status: "Enabled" },
    }));

    const output = awsSerializer.serialize(entities);
    const template = JSON.parse(output);

    expect(template.Resources.MyBucket.Properties.VersioningConfiguration).toEqual({
      Status: "Enabled",
    });
  });

  test("passes through property names verbatim", () => {
    const entities = new Map<string, Declarable>();
    entities.set("MyBucket", new MockBucket({ BucketName: "test" }));

    const output = awsSerializer.serialize(entities);
    const template = JSON.parse(output);

    expect(template.Resources.MyBucket.Properties.BucketName).toBeDefined();
  });

  test("handles multiple resources", () => {
    const entities = new Map<string, Declarable>();
    entities.set("DataBucket", new MockBucket({ BucketName: "data-bucket" }));
    entities.set("LogsBucket", new MockBucket({ BucketName: "logs-bucket" }));

    const output = awsSerializer.serialize(entities);
    const template = JSON.parse(output);

    expect(Object.keys(template.Resources)).toHaveLength(2);
    expect(template.Resources.DataBucket).toBeDefined();
    expect(template.Resources.LogsBucket).toBeDefined();
  });

  test("handles resources and parameters together", () => {
    const entities = new Map<string, Declarable>();
    entities.set("Env", new Parameter("String"));
    entities.set("MyBucket", new MockBucket({ BucketName: "bucket" }));

    const output = awsSerializer.serialize(entities);
    const template = JSON.parse(output);

    expect(template.Parameters).toBeDefined();
    expect(template.Resources).toBeDefined();
    expect(Object.keys(template.Parameters)).toHaveLength(1);
    expect(Object.keys(template.Resources)).toHaveLength(1);
  });

  test("omits undefined properties", () => {
    const entities = new Map<string, Declarable>();
    entities.set("MyBucket", new MockBucket({})); // No properties set

    const output = awsSerializer.serialize(entities);
    const template = JSON.parse(output);

    // Should have no Properties key or empty properties
    expect(template.Resources.MyBucket.Properties).toBeUndefined();
  });
});

// Mock property-kind Declarable for testing
class MockEncryption implements Declarable {
  readonly [DECLARABLE_MARKER] = true as const;
  readonly lexicon = "aws";
  readonly entityType = "AWS::S3::Bucket.BucketEncryption";
  readonly kind = "property" as const;
  readonly props: { ServerSideEncryptionConfiguration: unknown[] };

  constructor(props: { ServerSideEncryptionConfiguration: unknown[] }) {
    this.props = props;
  }
}

describe("property-kind Declarables", () => {
  test("property-kind Declarables are inlined into parent properties", () => {
    const encryption = new MockEncryption({
      ServerSideEncryptionConfiguration: [
        { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
      ],
    });

    const bucket = new MockBucket({ BucketName: "my-bucket" });
    // Manually set encryption as a prop
    (bucket.props as Record<string, unknown>).BucketEncryption = encryption;

    const entities = new Map<string, Declarable>();
    entities.set("DataEncryption", encryption);
    entities.set("MyBucket", bucket);

    const output = awsSerializer.serialize(entities);
    const template = JSON.parse(output);

    // Encryption should be inlined, not a Ref
    expect(template.Resources.MyBucket.Properties.BucketEncryption).toEqual({
      ServerSideEncryptionConfiguration: [
        { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
      ],
    });
  });

  test("property-kind Declarables do NOT appear as standalone Resources", () => {
    const encryption = new MockEncryption({
      ServerSideEncryptionConfiguration: [
        { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
      ],
    });

    const entities = new Map<string, Declarable>();
    entities.set("DataEncryption", encryption);
    entities.set("MyBucket", new MockBucket({ BucketName: "my-bucket" }));

    const output = awsSerializer.serialize(entities);
    const template = JSON.parse(output);

    expect(template.Resources.DataEncryption).toBeUndefined();
    expect(template.Resources.MyBucket).toBeDefined();
  });

  test("resource-kind Declarables still emit Ref when referenced", () => {
    const sourceBucket = new MockBucket({ BucketName: "source" });

    class MockConfig implements Declarable {
      readonly [DECLARABLE_MARKER] = true as const;
      readonly lexicon = "aws";
      readonly entityType = "AWS::S3::ReplicationDestination";
      readonly props: { Bucket: Declarable };

      constructor(Bucket: Declarable) {
        this.props = { Bucket };
      }
    }

    const entities = new Map<string, Declarable>();
    entities.set("SourceBucket", sourceBucket);
    entities.set("Config", new MockConfig(sourceBucket));

    const output = awsSerializer.serialize(entities);
    const template = JSON.parse(output);

    expect(template.Resources.Config.Properties.Bucket).toEqual({ Ref: "SourceBucket" });
  });
});

describe("intrinsic serialization", () => {
  test("handles AttrRef in properties", () => {
    const source = new MockBucket({ BucketName: "source" });
    // Set the logical name on the AttrRef before using it
    (source.arn as Record<string, unknown>)._setLogicalName("SourceBucket");

    class MockReplication implements Declarable {
      readonly [DECLARABLE_MARKER] = true as const;
      readonly lexicon = "aws";
      readonly entityType = "AWS::S3::ReplicationConfiguration";
      readonly props: { SourceArn: AttrRef };

      constructor(SourceArn: AttrRef) {
        this.props = { SourceArn };
      }
    }

    const entities = new Map<string, Declarable>();
    entities.set("SourceBucket", source);
    entities.set("Replication", new MockReplication(source.arn));

    const output = awsSerializer.serialize(entities);
    const template = JSON.parse(output);

    expect(template.Resources.Replication.Properties.SourceArn).toEqual({
      "Fn::GetAtt": ["SourceBucket", "Arn"],
    });
  });
});

describe("LexiconOutput serialization", () => {
  test("generates CF Outputs section for LexiconOutputs", () => {
    const bucket = new MockBucket({ BucketName: "data-bucket" });
    const lexiconOutput = new LexiconOutput(bucket.arn, "DataBucketArn");
    lexiconOutput._setSourceEntity("dataBucket");

    const entities = new Map<string, Declarable>();
    entities.set("dataBucket", bucket);

    const result = awsSerializer.serialize(entities, [lexiconOutput]);
    const template = JSON.parse(result);

    expect(template.Outputs).toBeDefined();
    expect(template.Outputs.DataBucketArn).toEqual({
      Value: { "Fn::GetAtt": ["dataBucket", "Arn"] },
    });
  });

  test("generates multiple CF Outputs", () => {
    const dataBucket = new MockBucket({ BucketName: "data-bucket" });
    const logsBucket = new MockBucket({ BucketName: "logs-bucket" });

    const dataOutput = new LexiconOutput(dataBucket.arn, "DataBucketArn");
    dataOutput._setSourceEntity("dataBucket");
    const logsOutput = new LexiconOutput(logsBucket.arn, "LogsBucketArn");
    logsOutput._setSourceEntity("logsBucket");

    const entities = new Map<string, Declarable>();
    entities.set("dataBucket", dataBucket);
    entities.set("logsBucket", logsBucket);

    const result = awsSerializer.serialize(entities, [dataOutput, logsOutput]);
    const template = JSON.parse(result);

    expect(template.Outputs).toBeDefined();
    expect(Object.keys(template.Outputs)).toHaveLength(2);
    expect(template.Outputs.DataBucketArn.Value).toEqual({
      "Fn::GetAtt": ["dataBucket", "Arn"],
    });
    expect(template.Outputs.LogsBucketArn.Value).toEqual({
      "Fn::GetAtt": ["logsBucket", "Arn"],
    });
  });

  test("omits Outputs section when no LexiconOutputs provided", () => {
    const entities = new Map<string, Declarable>();
    entities.set("MyBucket", new MockBucket({ BucketName: "bucket" }));

    const result = awsSerializer.serialize(entities);
    const template = JSON.parse(result);

    expect(template.Outputs).toBeUndefined();
  });

  test("omits Outputs section when empty LexiconOutputs array", () => {
    const entities = new Map<string, Declarable>();
    entities.set("MyBucket", new MockBucket({ BucketName: "bucket" }));

    const result = awsSerializer.serialize(entities, []);
    const template = JSON.parse(result as string);

    expect(template.Outputs).toBeUndefined();
  });
});

// ── Nested Stack Serialization ──────────────────────────

function mockChildBuildResult(childTemplate: object): BuildResult {
  return {
    outputs: new Map([["aws", JSON.stringify(childTemplate, null, 2)]]),
    entities: new Map(),
    warnings: [],
    errors: [],
    manifest: { lexicons: ["aws"], outputs: {}, deployOrder: ["aws"] },
    sourceFileCount: 1,
  };
}

describe("nested stack serialization", () => {
  test("returns SerializerResult with child template file", () => {
    const stack = nestedStack("network", "/path/to/network");
    stack.buildResult = mockChildBuildResult({
      AWSTemplateFormatVersion: "2010-09-09",
      Resources: {
        vpc: { Type: "AWS::EC2::VPC", Properties: { CidrBlock: "10.0.0.0/16" } },
      },
    });

    const entities = new Map<string, Declarable>();
    entities.set("network", stack as unknown as Declarable);

    const result = awsSerializer.serialize(entities);

    // Should be a SerializerResult, not a plain string
    expect(typeof result).toBe("object");
    const sr = result as SerializerResult;
    expect(sr.primary).toBeDefined();
    expect(sr.files).toBeDefined();
    expect(sr.files!["network.template.json"]).toBeDefined();
  });

  test("parent template has TemplateBasePath parameter", () => {
    const stack = nestedStack("network", "/path/to/network");
    stack.buildResult = mockChildBuildResult({
      AWSTemplateFormatVersion: "2010-09-09",
      Resources: {},
    });

    const entities = new Map<string, Declarable>();
    entities.set("network", stack as unknown as Declarable);

    const result = awsSerializer.serialize(entities) as SerializerResult;
    const parent = JSON.parse(result.primary);

    expect(parent.Parameters).toBeDefined();
    expect(parent.Parameters.TemplateBasePath).toBeDefined();
    expect(parent.Parameters.TemplateBasePath.Type).toBe("String");
    expect(parent.Parameters.TemplateBasePath.Default).toBe(".");
  });

  test("parent template has AWS::CloudFormation::Stack resource", () => {
    const stack = nestedStack("network", "/path/to/network");
    stack.buildResult = mockChildBuildResult({
      AWSTemplateFormatVersion: "2010-09-09",
      Resources: {},
    });

    const entities = new Map<string, Declarable>();
    entities.set("network", stack as unknown as Declarable);

    const result = awsSerializer.serialize(entities) as SerializerResult;
    const parent = JSON.parse(result.primary);

    expect(parent.Resources.network).toBeDefined();
    expect(parent.Resources.network.Type).toBe("AWS::CloudFormation::Stack");
    expect(parent.Resources.network.Properties.TemplateURL).toEqual({
      "Fn::Sub": "${TemplateBasePath}/network.template.json",
    });
  });

  test("explicit parameters are passed to child stack", () => {
    const stack = nestedStack("network", "/path/to/network", {
      parameters: { Environment: "prod" },
    });
    stack.buildResult = mockChildBuildResult({
      AWSTemplateFormatVersion: "2010-09-09",
      Resources: {},
    });

    const entities = new Map<string, Declarable>();
    entities.set("network", stack as unknown as Declarable);

    const result = awsSerializer.serialize(entities) as SerializerResult;
    const parent = JSON.parse(result.primary);

    // Parameters should be passed to the stack resource
    expect(parent.Resources.network.Properties.Parameters.Environment).toBe("prod");
    expect(parent.Resources.network.Properties.Parameters.TemplateBasePath).toEqual({
      Ref: "TemplateBasePath",
    });
  });

  test("mixed nested and regular resources work together", () => {
    const stack = nestedStack("network", "/path/to/network");
    stack.buildResult = mockChildBuildResult({
      AWSTemplateFormatVersion: "2010-09-09",
      Resources: {},
    });

    const bucket = new MockBucket({ BucketName: "data" });

    const entities = new Map<string, Declarable>();
    entities.set("network", stack as unknown as Declarable);
    entities.set("dataBucket", bucket);

    const result = awsSerializer.serialize(entities) as SerializerResult;
    const parent = JSON.parse(result.primary);

    // Both should be in parent
    expect(parent.Resources.network.Type).toBe("AWS::CloudFormation::Stack");
    expect(parent.Resources.dataBucket.Type).toBe("AWS::S3::Bucket");
  });

  test("without nested stacks returns plain string", () => {
    const entities = new Map<string, Declarable>();
    entities.set("MyBucket", new MockBucket({ BucketName: "bucket" }));

    const result = awsSerializer.serialize(entities);
    expect(typeof result).toBe("string");
  });

  test("cross-stack ref via NestedStackOutputRef serializes correctly in parent", () => {
    const stack = nestedStack("network", "/path/to/network");
    stack.buildResult = mockChildBuildResult({
      AWSTemplateFormatVersion: "2010-09-09",
      Resources: {
        subnet: { Type: "AWS::EC2::Subnet" },
      },
      Outputs: {
        subnetId: { Value: { "Fn::GetAtt": ["subnet", "SubnetId"] } },
      },
    });

    // Create a function that uses network.outputs.subnetId
    const subnetRef = new NestedStackOutputRef("network", "subnetId");
    const fn = {
      [DECLARABLE_MARKER]: true,
      lexicon: "aws",
      entityType: "AWS::Lambda::Function",
      kind: "resource" as const,
      props: {
        VpcConfig: { SubnetIds: [subnetRef] },
      },
    } as unknown as Declarable;

    const entities = new Map<string, Declarable>();
    entities.set("network", stack as unknown as Declarable);
    entities.set("handler", fn);

    const result = awsSerializer.serialize(entities) as SerializerResult;
    const parent = JSON.parse(result.primary);

    // The NestedStackOutputRef should serialize via toJSON()
    const vpcConfig = parent.Resources.handler.Properties.VpcConfig;
    expect(vpcConfig.SubnetIds[0]).toEqual({
      "Fn::GetAtt": ["network", "Outputs.subnetId"],
    });
  });
});
