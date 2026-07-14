import { describe, test, expect } from "vitest";
import { expandComposite } from "@intentius/chant";
import { AttrRef } from "@intentius/chant/attrref";
// resolveAttrRefs stamps logical names onto AttrRefs before serialization —
// normally the discover→resolve→serialize pipeline (`chant build`) does this;
// reaching into core directly here mirrors nested-stack-integration.test.ts's
// precedent for aws-lexicon integration-style tests.
import { resolveAttrRefs } from "../../../../packages/core/src/discovery/resolve";
import { AgentCoreAgent } from "./agentcore-agent";
import { awsSerializer } from "../serializer";

const baseProps = {
  name: "support-agent",
  containerUri: "123456789012.dkr.ecr.us-east-1.amazonaws.com/support-agent:latest",
};

describe("AgentCoreAgent", () => {
  test("returns all 8 members", () => {
    const instance = AgentCoreAgent(baseProps);
    expect(Object.keys(instance.members)).toEqual([
      "role", "gatewayRole", "runtime", "endpoint", "memory",
      "workloadIdentity", "gateway", "gatewayTarget",
    ]);
  });

  test("expandComposite produces correct logical names", () => {
    const expanded = expandComposite("agent", AgentCoreAgent(baseProps));
    expect(expanded.has("agentRole")).toBe(true);
    expect(expanded.has("agentGatewayRole")).toBe(true);
    expect(expanded.has("agentRuntime")).toBe(true);
    expect(expanded.has("agentEndpoint")).toBe(true);
    expect(expanded.has("agentMemory")).toBe(true);
    expect(expanded.has("agentWorkloadIdentity")).toBe(true);
    expect(expanded.has("agentGateway")).toBe(true);
    expect(expanded.has("agentGatewayTarget")).toBe(true);
    expect(expanded.size).toBe(8);
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
    const instance = AgentCoreAgent(baseProps);
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

  test("throws when memoryEventExpiryDays is out of CFN bounds (3-365)", () => {
    expect(() => AgentCoreAgent({ ...baseProps, memoryEventExpiryDays: 1 })).toThrow(
      "AgentCoreAgent memoryEventExpiryDays must be between 3 and 365",
    );
    expect(() => AgentCoreAgent({ ...baseProps, memoryEventExpiryDays: 400 })).toThrow(
      "AgentCoreAgent memoryEventExpiryDays must be between 3 and 365",
    );
  });

  test("RuntimeEndpoint references runtime.AgentRuntimeId", () => {
    const instance = AgentCoreAgent(baseProps);
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
      ...baseProps,
      defaults: { endpoint: { Description: "prod alias" } },
    });
    const endpointProps = (instance.endpoint as any).props;
    expect(endpointProps.Description).toBe("prod alias");
  });

  test("serializes to a valid CloudFormation template with the expected resource types", () => {
    const expanded = expandComposite("agent", AgentCoreAgent(baseProps));
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
