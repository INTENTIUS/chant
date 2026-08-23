import { describe, test, expect } from "vitest";
import { expandComposite } from "@intentius/chant";
import { AttrRef } from "@intentius/chant/attrref";
import { resolveAttrRefs } from "@intentius/chant/discovery/resolve";
import { awsSerializer } from "../serializer";
import { MicrovmApp, MICROVM_LIMITS } from "./microvm-app";

const baseProps = {
  name: "worker-image",
  description: "Worker MicroVM image",
  codeArtifactUri: "s3://microvm-artifacts/worker/context.zip",
  codeArtifactObjectArn: "arn:aws:s3:::microvm-artifacts/worker/context.zip",
  baseImage: "al2023-1",
  baseImageVersion: "0",
};

describe("MicrovmApp", () => {
  test("returns buildRole, executionRole, and image members (no connector)", () => {
    const instance = MicrovmApp(baseProps);
    expect(instance.buildRole).toBeDefined();
    expect(instance.executionRole).toBeDefined();
    expect(instance.image).toBeDefined();
    expect(instance.connector).toBeUndefined();
    expect(instance.connectorSecurityGroup).toBeUndefined();
    expect(instance.connectorOperatorRole).toBeUndefined();
    expect(Object.keys(instance.members)).toEqual(["buildRole", "executionRole", "image"]);
  });

  test("image.BuildRoleArn references buildRole.Arn via AttrRef", () => {
    const instance = MicrovmApp(baseProps);
    const imageProps = (instance.image as any).props;
    expect(imageProps.BuildRoleArn).toBeInstanceOf(AttrRef);
  });

  test("defaults: memory 2048MiB, ARM_64, empty os capabilities, logging enabled", () => {
    const instance = MicrovmApp(baseProps);
    const imageProps = (instance.image as any).props;
    expect(imageProps.Resources[0].props.MinimumMemoryInMiB).toBe(2048);
    expect(imageProps.CpuConfigurations[0].props.Architecture).toBe("ARM_64");
    expect(imageProps.AdditionalOsCapabilities).toEqual([]);
    expect(imageProps.EgressNetworkConnectors).toEqual([]);
    expect(imageProps.Logging.props.CloudWatch.props.LogGroup).toBe("/aws/lambda/microvms/worker-image");
  });

  test("disableLogging emits Logging.Disabled", () => {
    const instance = MicrovmApp({ ...baseProps, disableLogging: true });
    const imageProps = (instance.image as any).props;
    expect(imageProps.Logging.props.Disabled).toBe(true);
    expect(imageProps.Logging.props.CloudWatch).toBeUndefined();
  });

  test("environment variables become Key/Value pairs", () => {
    const instance = MicrovmApp({ ...baseProps, environment: { MODE: "prod" } });
    const imageProps = (instance.image as any).props;
    expect(imageProps.EnvironmentVariables).toHaveLength(1);
    expect(imageProps.EnvironmentVariables[0].props).toEqual({ Key: "MODE", Value: "prod" });
  });

  test("rejects a reserved AWS_REGION environment key", () => {
    expect(() => MicrovmApp({ ...baseProps, environment: { AWS_REGION: "us-east-1" } })).toThrow(/reserved/);
  });

  test("rejects an invalid memoryMiB", () => {
    expect(() => MicrovmApp({ ...baseProps, memoryMiB: 3000 as any })).toThrow(/memoryMiB/);
  });

  test("rejects an invalid name", () => {
    expect(() => MicrovmApp({ ...baseProps, name: "bad name!" })).toThrow(/name must match/);
  });

  test("full ARN base image passes through; alias resolves via Sub", () => {
    const aliasInstance = MicrovmApp(baseProps);
    const aliasArn = (aliasInstance.image as any).props.BaseImageArn;
    expect(aliasArn).not.toBe("al2023-1");
    expect(typeof aliasArn).toBe("object"); // SubIntrinsic

    const fullArn = "arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1";
    const arnInstance = MicrovmApp({ ...baseProps, baseImage: fullArn });
    expect((arnInstance.image as any).props.BaseImageArn).toBe(fullArn);
  });

  describe("with buildConnector", () => {
    const withConnector = {
      ...baseProps,
      buildConnector: { vpcId: "vpc-123", subnetIds: ["subnet-1", "subnet-2"] },
    };

    test("adds connectorSecurityGroup, connectorOperatorRole, and connector members", () => {
      const instance = MicrovmApp(withConnector);
      expect(instance.connectorSecurityGroup).toBeDefined();
      expect(instance.connectorOperatorRole).toBeDefined();
      expect(instance.connector).toBeDefined();
      expect(Object.keys(instance.members)).toEqual([
        "buildRole",
        "executionRole",
        "image",
        "connectorSecurityGroup",
        "connectorOperatorRole",
        "connector",
      ]);
    });

    test("connector security group is deny-all egress, no ingress", () => {
      const instance = MicrovmApp(withConnector);
      const sgProps = (instance.connectorSecurityGroup as any).props;
      expect(sgProps.SecurityGroupIngress).toBeUndefined();
      expect(sgProps.SecurityGroupEgress).toHaveLength(1);
      expect(sgProps.SecurityGroupEgress[0].props).toEqual({
        CidrIp: "255.255.255.255/32",
        Description: "Disallow all traffic",
        IpProtocol: "icmp",
        FromPort: 252,
        ToPort: 86,
      });
    });

    test("image.EgressNetworkConnectors references connector.Arn", () => {
      const instance = MicrovmApp(withConnector);
      const imageProps = (instance.image as any).props;
      expect(imageProps.EgressNetworkConnectors).toHaveLength(1);
      expect(imageProps.EgressNetworkConnectors[0]).toBeInstanceOf(AttrRef);
    });

    test("rejects an out-of-range subnet count", () => {
      expect(() =>
        MicrovmApp({ ...baseProps, buildConnector: { vpcId: "vpc-1", subnetIds: [] } }),
      ).toThrow(/subnets/);
    });

    test("additionalEgressConnectors plus a buildConnector over the max of 10 throws", () => {
      const extra = Array.from({ length: 10 }, (_, i) => `arn:aws:lambda:us-east-1:123456789012:network-connector:nc-${i}`);
      expect(() =>
        MicrovmApp({ ...withConnector, additionalEgressConnectors: extra }),
      ).toThrow(/egress connectors/);
    });
  });

  test("expandComposite produces correct logical names (no connector)", () => {
    const instance = MicrovmApp(baseProps);
    const expanded = expandComposite("worker", instance);
    expect(expanded.has("workerBuildRole")).toBe(true);
    expect(expanded.has("workerExecutionRole")).toBe(true);
    expect(expanded.has("workerImage")).toBe(true);
    expect(expanded.size).toBe(3);
  });

  describe("CloudFormation serialization", () => {
    test("serializes to a valid CloudFormation template (no connector)", () => {
      const instance = MicrovmApp(baseProps);
      const entities = expandComposite("worker", instance);
      resolveAttrRefs(entities);
      const output = awsSerializer.serialize(entities) as string;
      const template = JSON.parse(output);

      expect(template.AWSTemplateFormatVersion).toBe("2010-09-09");

      const image = template.Resources.workerImage;
      expect(image.Type).toBe("AWS::Lambda::MicrovmImage");
      expect(image.Properties.Name).toBe("worker-image");
      expect(image.Properties.Description).toBe("Worker MicroVM image");
      expect(image.Properties.CodeArtifact).toEqual({ Uri: "s3://microvm-artifacts/worker/context.zip" });
      expect(image.Properties.CpuConfigurations).toEqual([{ Architecture: "ARM_64" }]);
      expect(image.Properties.Resources).toEqual([{ MinimumMemoryInMiB: 2048 }]);
      expect(image.Properties.AdditionalOsCapabilities).toEqual([]);
      expect(image.Properties.EgressNetworkConnectors).toEqual([]);
      expect(image.Properties.Hooks).toEqual({});
      expect(image.Properties.BuildRoleArn).toEqual({ "Fn::GetAtt": ["workerBuildRole", "Arn"] });

      const buildRole = template.Resources.workerBuildRole;
      expect(buildRole.Type).toBe("AWS::IAM::Role");
      expect(buildRole.Properties.AssumeRolePolicyDocument.Statement).toHaveLength(2);
      expect(buildRole.Properties.Policies[0].PolicyDocument.Statement[0].Resource).toBe(
        "arn:aws:s3:::microvm-artifacts/worker/context.zip",
      );

      const executionRole = template.Resources.workerExecutionRole;
      expect(executionRole.Type).toBe("AWS::IAM::Role");
      expect(executionRole.Properties.Policies[0].PolicyName).toBe("MicrovmRuntimeLogs");

      // Required CFN properties for AWS::Lambda::MicrovmImage all present.
      for (const key of [
        "Name",
        "BaseImageArn",
        "BaseImageVersion",
        "BuildRoleArn",
        "Description",
        "CodeArtifact",
        "Logging",
        "EgressNetworkConnectors",
        "CpuConfigurations",
        "Resources",
        "AdditionalOsCapabilities",
        "Hooks",
        "EnvironmentVariables",
      ]) {
        expect(image.Properties).toHaveProperty(key);
      }
    });

    test("serializes the network connector + its security group and operator role", () => {
      const instance = MicrovmApp({
        ...baseProps,
        buildConnector: { vpcId: "vpc-123", subnetIds: ["subnet-1", "subnet-2"], networkProtocol: "DualStack" },
      });
      const entities = expandComposite("worker", instance);
      resolveAttrRefs(entities);
      const output = awsSerializer.serialize(entities) as string;
      const template = JSON.parse(output);

      const connector = template.Resources.workerConnector;
      expect(connector.Type).toBe("AWS::Lambda::NetworkConnector");
      expect(connector.Properties.OperatorRole).toEqual({ "Fn::GetAtt": ["workerConnectorOperatorRole", "Arn"] });
      expect(connector.Properties.Configuration.VpcEgressConfiguration).toEqual({
        AssociatedComputeResourceTypes: ["MicroVm"],
        SubnetIds: ["subnet-1", "subnet-2"],
        SecurityGroupIds: [{ "Fn::GetAtt": ["workerConnectorSecurityGroup", "GroupId"] }],
        NetworkProtocol: "DualStack",
      });

      const sg = template.Resources.workerConnectorSecurityGroup;
      expect(sg.Type).toBe("AWS::EC2::SecurityGroup");
      expect(sg.Properties.VpcId).toBe("vpc-123");

      const operatorRole = template.Resources.workerConnectorOperatorRole;
      expect(operatorRole.Type).toBe("AWS::IAM::Role");
      expect(operatorRole.Properties.AssumeRolePolicyDocument.Statement).toHaveLength(1);

      const image = template.Resources.workerImage;
      expect(image.Properties.EgressNetworkConnectors).toEqual([
        { "Fn::GetAtt": ["workerConnector", "Arn"] },
      ]);
    });
  });
});

describe("MICROVM_LIMITS", () => {
  // The composite validates against these; a consumer driving the same service
  // through a different control plane needs the same numbers, and copying them
  // is how two sources of truth start (#1374).
  test("is reachable from the package root", async () => {
    const root = await import("../index");
    expect(root.MICROVM_LIMITS).toBe(MICROVM_LIMITS);
  });

  test("is what the composite actually enforces", () => {
    // Not a restatement of the constants — a probe through the public API, so
    // the two cannot drift apart while both look right.
    expect(() => MicrovmApp({ ...baseProps, memoryMiB: 3072 as never })).toThrow(
      new RegExp(MICROVM_LIMITS.memoryMiB.join(", ")),
    );
    expect(() => MicrovmApp({ ...baseProps, name: "no spaces allowed" })).toThrow(/name must match/);
    expect(() =>
      MicrovmApp({ ...baseProps, name: "x".repeat(MICROVM_LIMITS.maxNameLength + 1) }),
    ).toThrow(/≤64 chars/);
    expect(() =>
      MicrovmApp({ ...baseProps, environment: { AWS_REGION: "us-east-1" } }),
    ).toThrow(/AWS_REGION/);
  });

  test("names every limit the composite checks", () => {
    // A limit enforced and not named here is one a consumer cannot see.
    expect(Object.keys(MICROVM_LIMITS).sort()).toEqual([
      "connectorSubnets",
      "maxEgressConnectors",
      "maxEnvironmentVariables",
      "maxNameLength",
      "memoryMiB",
      "namePattern",
      "reservedEnvironmentKeys",
    ]);
  });
});
