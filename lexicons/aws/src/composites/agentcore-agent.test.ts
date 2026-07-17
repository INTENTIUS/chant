import { describe, test, expect } from "vitest";
import { expandComposite } from "@intentius/chant";
import { AttrRef } from "@intentius/chant/attrref";
// resolveAttrRefs stamps logical names onto AttrRefs before serialization —
// normally the discover→resolve→serialize pipeline (`chant build`) does this;
// reaching into core directly here mirrors nested-stack-integration.test.ts's
// precedent for aws-lexicon integration-style tests.
import { resolveAttrRefs } from "../../../../packages/core/src/discovery/resolve";
import { AgentCoreAgent } from "./agentcore-agent";
import { Split, Ref } from "../intrinsics";
import { awsSerializer } from "../serializer";

const baseProps = {
  name: "support-agent",
  containerUri: "123456789012.dkr.ecr.us-east-1.amazonaws.com/support-agent:latest",
};

// The endpoint is opt-in (#978) — it races the Runtime's async version-READY when
// created in the same apply. Tests that exercise the endpoint pass this variant.
const withEndpoint = { ...baseProps, provisionEndpoint: true };

describe("AgentCoreAgent", () => {
  test("returns 7 members by default; the endpoint is opt-in (#978)", () => {
    const instance = AgentCoreAgent(baseProps);
    expect(Object.keys(instance.members)).toEqual([
      "role", "gatewayRole", "runtime", "memory",
      "workloadIdentity", "gateway", "gatewayTarget",
    ]);
    expect((instance as any).endpoint).toBeUndefined();
  });

  test("provisionEndpoint adds the endpoint as an 8th member", () => {
    const instance = AgentCoreAgent(withEndpoint);
    expect(Object.keys(instance.members)).toContain("endpoint");
    expect(Object.keys(instance.members)).toHaveLength(8);
  });

  test("expandComposite produces correct logical names", () => {
    const expanded = expandComposite("agent", AgentCoreAgent(baseProps));
    expect(expanded.has("agentRole")).toBe(true);
    expect(expanded.has("agentGatewayRole")).toBe(true);
    expect(expanded.has("agentRuntime")).toBe(true);
    expect(expanded.has("agentEndpoint")).toBe(false); // opt-in (#978)
    expect(expanded.has("agentMemory")).toBe(true);
    expect(expanded.has("agentWorkloadIdentity")).toBe(true);
    expect(expanded.has("agentGateway")).toBe(true);
    expect(expanded.has("agentGatewayTarget")).toBe(true);
    expect(expanded.size).toBe(7);
    // With the endpoint opted in, it appears as agentEndpoint.
    expect(expandComposite("agent", AgentCoreAgent(withEndpoint)).has("agentEndpoint")).toBe(true);
  });

  test("role and gatewayRole trust bedrock-agentcore.amazonaws.com", () => {
    const instance = AgentCoreAgent(baseProps);
    const roleProps = (instance.role as any).props;
    const gatewayRoleProps = (instance.gatewayRole as any).props;
    expect(roleProps.AssumeRolePolicyDocument.Statement[0].Principal.Service).toBe(
      "bedrock-agentcore.amazonaws.com",
    );
    expect(gatewayRoleProps.AssumeRolePolicyDocument.Statement[0].Principal.Service).toBe(
      "bedrock-agentcore.amazonaws.com",
    );
  });

  test("kebab-case name is sanitized for Runtime/RuntimeEndpoint/Memory (no hyphens)", () => {
    const instance = AgentCoreAgent(withEndpoint);
    const runtimeProps = (instance.runtime as any).props;
    const endpointProps = (instance.endpoint as any).props;
    const memoryProps = (instance.memory as any).props;
    expect(runtimeProps.AgentRuntimeName).toBe("support_agent");
    expect(runtimeProps.AgentRuntimeName).toMatch(/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/);
    expect(endpointProps.Name).toBe("DEFAULT");
    expect(memoryProps.Name).toBe("support_agentMemory");
    expect(memoryProps.Name).toMatch(/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/);
  });

  test("Gateway/GatewayTarget/WorkloadIdentity keep the raw kebab-case name (hyphens allowed)", () => {
    const instance = AgentCoreAgent(baseProps);
    const gatewayProps = (instance.gateway as any).props;
    const targetProps = (instance.gatewayTarget as any).props;
    const identityProps = (instance.workloadIdentity as any).props;
    expect(gatewayProps.Name).toBe("support-agent-gateway");
    expect(targetProps.Name).toBe("support-agent-target");
    expect(identityProps.Name).toBe("support-agent-identity");
  });

  test("Runtime wires RoleArn, ContainerUri, and defaults to MCP/PUBLIC", () => {
    const instance = AgentCoreAgent(baseProps);
    const runtimeProps = (instance.runtime as any).props;
    expect(runtimeProps.RoleArn).toBeInstanceOf(AttrRef);
    expect(runtimeProps.ProtocolConfiguration).toBe("MCP");
    const artifactProps = (runtimeProps.AgentRuntimeArtifact as any).props;
    const containerProps = (artifactProps.ContainerConfiguration as any).props;
    expect(containerProps.ContainerUri).toBe(baseProps.containerUri);
    const networkProps = (runtimeProps.NetworkConfiguration as any).props;
    expect(networkProps.NetworkMode).toBe("PUBLIC");
    expect(networkProps.NetworkModeConfig).toBeUndefined();
  });

  test("code-config path wires CodeConfiguration (S3 zip on a managed runtime) instead of a container", () => {
    const instance = AgentCoreAgent({
      name: "support-agent",
      code: {
        s3Bucket: "loom-artifacts",
        s3Prefix: "agents/assistant.zip",
        runtime: "PYTHON_3_12",
        entryPoint: ["app.py"],
      },
    });
    const artifactProps = ((instance.runtime as any).props.AgentRuntimeArtifact as any).props;
    expect(artifactProps.ContainerConfiguration).toBeUndefined();
    const codeProps = (artifactProps.CodeConfiguration as any).props;
    expect(codeProps.Runtime).toBe("PYTHON_3_12");
    expect(codeProps.EntryPoint).toEqual(["app.py"]);
    const s3 = (codeProps.Code as any).props.S3;
    expect(s3).toEqual({ Bucket: "loom-artifacts", Prefix: "agents/assistant.zip" });
  });

  test("code-config VersionId is threaded through only when supplied", () => {
    const withVersion = AgentCoreAgent({
      name: "support-agent",
      code: { s3Bucket: "b", s3Prefix: "k.zip", runtime: "PYTHON_3_12", entryPoint: ["app.py"], s3VersionId: "v1" },
    });
    const s3 = (((withVersion.runtime as any).props.AgentRuntimeArtifact as any).props.CodeConfiguration as any).props.Code.props.S3;
    expect(s3.VersionId).toBe("v1");
  });

  test("throws when neither containerUri nor code is supplied", () => {
    expect(() => AgentCoreAgent({ name: "support-agent" } as any)).toThrow(
      "AgentCoreAgent requires exactly one of containerUri or code",
    );
  });

  test("throws when both containerUri and code are supplied", () => {
    expect(() => AgentCoreAgent({
      ...baseProps,
      code: { s3Bucket: "b", s3Prefix: "k.zip", runtime: "PYTHON_3_12", entryPoint: ["app.py"] },
    })).toThrow("AgentCoreAgent requires exactly one of containerUri or code");
  });

  test("code-config serializes to a valid CloudFormation Runtime resource", () => {
    const expanded = expandComposite("agent", AgentCoreAgent({
      name: "support-agent",
      code: { s3Bucket: "loom-artifacts", s3Prefix: "agents/assistant.zip", runtime: "PYTHON_3_12", entryPoint: ["app.py"] },
    }));
    resolveAttrRefs(expanded);
    const template = JSON.parse(awsSerializer.serialize(expanded));
    const artifact = template.Resources.agentRuntime.Properties.AgentRuntimeArtifact;
    expect(artifact.ContainerConfiguration).toBeUndefined();
    expect(artifact.CodeConfiguration).toEqual({
      Code: { S3: { Bucket: "loom-artifacts", Prefix: "agents/assistant.zip" } },
      EntryPoint: ["app.py"],
      Runtime: "PYTHON_3_12",
    });
  });

  test("VPC network mode wires NetworkModeConfig from vpcSubnetIds/vpcSecurityGroupIds", () => {
    const instance = AgentCoreAgent({
      ...baseProps,
      networkMode: "VPC",
      vpcSubnetIds: ["subnet-1", "subnet-2"],
      vpcSecurityGroupIds: ["sg-1"],
    });
    const runtimeProps = (instance.runtime as any).props;
    const networkProps = (runtimeProps.NetworkConfiguration as any).props;
    expect(networkProps.NetworkMode).toBe("VPC");
    const vpcConfigProps = (networkProps.NetworkModeConfig as any).props;
    expect(vpcConfigProps.Subnets).toEqual(["subnet-1", "subnet-2"]);
    expect(vpcConfigProps.SecurityGroups).toEqual(["sg-1"]);
  });

  test("throws when networkMode is VPC without subnets/security groups", () => {
    expect(() => AgentCoreAgent({ ...baseProps, networkMode: "VPC" })).toThrow(
      "AgentCoreAgent requires vpcSubnetIds and vpcSecurityGroupIds when networkMode is \"VPC\"",
    );
  });

  test("VPC mode accepts a cross-stack intrinsic (Fn::Split) — checks presence, not .length (#938)", () => {
    // A cross-stack value (Split of a Parameter) is a truthy intrinsic with no
    // `.length`; it WAS supplied, so the composite must not reject it.
    const subnets = Split(",", Ref("SubnetIdsParam")) as unknown as string[];
    const sgs = Split(",", Ref("SgIdsParam")) as unknown as string[];
    const instance = AgentCoreAgent({ ...baseProps, networkMode: "VPC", vpcSubnetIds: subnets, vpcSecurityGroupIds: sgs });
    const vpcConfigProps = ((instance.runtime as any).props.NetworkConfiguration as any).props.NetworkModeConfig.props;
    expect(vpcConfigProps.Subnets).toBe(subnets);
    expect(vpcConfigProps.SecurityGroups).toBe(sgs);
  });

  test("throws when memoryEventExpiryDays is out of CFN bounds (3-365)", () => {
    expect(() => AgentCoreAgent({ ...baseProps, memoryEventExpiryDays: 1 })).toThrow(
      "AgentCoreAgent memoryEventExpiryDays must be between 3 and 365",
    );
    expect(() => AgentCoreAgent({ ...baseProps, memoryEventExpiryDays: 400 })).toThrow(
      "AgentCoreAgent memoryEventExpiryDays must be between 3 and 365",
    );
  });

  test("RuntimeEndpoint references runtime.AgentRuntimeId (when opted in)", () => {
    const instance = AgentCoreAgent(withEndpoint);
    const endpointProps = (instance.endpoint as any).props;
    expect(endpointProps.AgentRuntimeId).toBeInstanceOf(AttrRef);
  });

  test("Memory defaults EventExpiryDuration and MemoryExecutionRoleArn", () => {
    const instance = AgentCoreAgent(baseProps);
    const memoryProps = (instance.memory as any).props;
    expect(memoryProps.EventExpiryDuration).toBe(30);
    expect(memoryProps.MemoryExecutionRoleArn).toBeInstanceOf(AttrRef);
  });

  test("GatewayTarget defaults to routing back at the agent's own Runtime", () => {
    const instance = AgentCoreAgent(baseProps);
    const targetProps = (instance.gatewayTarget as any).props;
    expect(targetProps.GatewayIdentifier).toBeInstanceOf(AttrRef);
    const runtimeArnRef = targetProps.TargetConfiguration.Http.AgentcoreRuntime.Arn;
    expect(runtimeArnRef).toBeInstanceOf(AttrRef);
  });

  test("Gateway defaults to AWS_IAM authorizer, override is respected", () => {
    const instance = AgentCoreAgent(baseProps);
    const gatewayProps = (instance.gateway as any).props;
    expect(gatewayProps.AuthorizerType).toBe("AWS_IAM");

    const custom = AgentCoreAgent({ ...baseProps, gatewayAuthorizerType: "NONE" });
    const customGatewayProps = (custom.gateway as any).props;
    expect(customGatewayProps.AuthorizerType).toBe("NONE");
  });

  test("ManagedPolicyArns and Policies pass through to the runtime role", () => {
    const arn = "arn:aws:iam::aws:policy/AmazonBedrockFullAccess";
    const instance = AgentCoreAgent({ ...baseProps, ManagedPolicyArns: [arn] });
    const roleProps = (instance.role as any).props;
    expect(roleProps.ManagedPolicyArns).toContain(arn);
  });

  test("per-member defaults are applied (e.g. custom endpoint description)", () => {
    const instance = AgentCoreAgent({
      ...withEndpoint,
      defaults: { endpoint: { Description: "prod alias" } },
    });
    const endpointProps = (instance.endpoint as any).props;
    expect(endpointProps.Description).toBe("prod alias");
  });

  test("serializes to a valid CloudFormation template with the expected resource types", () => {
    const expanded = expandComposite("agent", AgentCoreAgent(withEndpoint));
    resolveAttrRefs(expanded);
    const output = awsSerializer.serialize(expanded);
    const template = JSON.parse(output);

    expect(template.AWSTemplateFormatVersion).toBe("2010-09-09");
    expect(template.Resources.agentRole.Type).toBe("AWS::IAM::Role");
    expect(template.Resources.agentGatewayRole.Type).toBe("AWS::IAM::Role");
    expect(template.Resources.agentRuntime.Type).toBe("AWS::BedrockAgentCore::Runtime");
    expect(template.Resources.agentEndpoint.Type).toBe("AWS::BedrockAgentCore::RuntimeEndpoint");
    expect(template.Resources.agentMemory.Type).toBe("AWS::BedrockAgentCore::Memory");
    expect(template.Resources.agentWorkloadIdentity.Type).toBe("AWS::BedrockAgentCore::WorkloadIdentity");
    expect(template.Resources.agentGateway.Type).toBe("AWS::BedrockAgentCore::Gateway");
    expect(template.Resources.agentGatewayTarget.Type).toBe("AWS::BedrockAgentCore::GatewayTarget");

    // Cross-references resolved to CFN intrinsics, not left as live objects.
    expect(template.Resources.agentRuntime.Properties.RoleArn).toEqual({ "Fn::GetAtt": ["agentRole", "Arn"] });
    expect(template.Resources.agentEndpoint.Properties.AgentRuntimeId).toEqual({
      "Fn::GetAtt": ["agentRuntime", "AgentRuntimeId"],
    });
    expect(template.Resources.agentGatewayTarget.Properties.TargetConfiguration).toEqual({
      Http: { AgentcoreRuntime: { Arn: { "Fn::GetAtt": ["agentRuntime", "AgentRuntimeArn"] } } },
    });
  });
});
