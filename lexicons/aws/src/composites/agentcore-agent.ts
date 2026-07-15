import { Composite, mergeDefaults } from "@intentius/chant";
import {
  Role,
  Role_Policy,
  Runtime,
  Runtime_AgentRuntimeArtifact,
  Runtime_ContainerConfiguration,
  Runtime_NetworkConfiguration,
  Runtime_VpcConfig,
  RuntimeEndpoint,
  Memory,
  BedrockAgentCoreGateway,
  GatewayTarget,
  WorkloadIdentity,
} from "../generated";
import { agentCoreTrustPolicy } from "./agentcore-trust-policy";

/**
 * AgentCore's `Runtime`/`RuntimeEndpoint`/`Memory` `Name`/`AgentRuntimeName`
 * fields are all bound to the CFN registry pattern
 * `^[a-zA-Z][a-zA-Z0-9_]{0,47}$` (spot-checked against the CloudFormation
 * schema for #882 — no hyphens, unlike chant's usual kebab-case component
 * names). `Gateway`/`GatewayTarget`/`WorkloadIdentity` names accept hyphens,
 * so only the Runtime family needs sanitizing. Non-identifier characters
 * become `_`, and a leading digit/underscore gets an `A` prefix so the result
 * always starts with a letter.
 */
function toRuntimeIdentifier(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_]/g, "_");
  const identifier = /^[a-zA-Z]/.test(cleaned) ? cleaned : `A${cleaned}`;
  return identifier.slice(0, 48);
}

export interface AgentCoreAgentProps {
  /**
   * Base name for the agent's resources. `toRuntimeIdentifier(name)` derives
   * the Runtime/RuntimeEndpoint/Memory names; Gateway/GatewayTarget/
   * WorkloadIdentity use `name` as-is (hyphens are valid there).
   */
  name: string;
  /** ECR image URI the Runtime runs, e.g. `"123456789012.dkr.ecr.us-east-1.amazonaws.com/agent:latest"`. */
  containerUri: string;
  /** Runtime network mode. Default: "PUBLIC". */
  networkMode?: "PUBLIC" | "VPC";
  /** Subnets for the Runtime's ENIs. Required when `networkMode` is "VPC". */
  vpcSubnetIds?: string[];
  /** Security groups for the Runtime's ENIs. Required when `networkMode` is "VPC". */
  vpcSecurityGroupIds?: string[];
  /** Protocol the Runtime serves. Mirrors the generated `Runtime_ProtocolConfiguration` CFN enum. Default: "MCP". */
  protocolConfiguration?: "A2A" | "AGUI" | "HTTP" | "MCP";
  /** Environment variables passed to the Runtime container. */
  environmentVariables?: Record<string, string>;
  /** RuntimeEndpoint name — the alias a version-promotion capability would repoint (deferred, see #882). Default: "DEFAULT". */
  endpointName?: string;
  /** Memory event retention, in days. CFN bounds: 3-365. Default: 30. */
  memoryEventExpiryDays?: number;
  /** Gateway authorizer. Mirrors the generated `BedrockAgentCoreGateway_AuthorizerType` CFN enum. Default: "AWS_IAM". */
  gatewayAuthorizerType?: "CUSTOM_JWT" | "AWS_IAM" | "NONE" | "AUTHENTICATE_ONLY";
  /** Allow-listed OAuth2 return URLs for the standalone `WorkloadIdentity` resource. */
  allowedResourceOauth2ReturnUrls?: string[];
  /** Extra managed policy ARNs merged onto the auto-created Runtime/Memory execution role. */
  ManagedPolicyArns?: string[];
  /** Inline policies attached to the auto-created Runtime/Memory execution role. */
  Policies?: InstanceType<typeof Role_Policy>[];
  defaults?: {
    role?: Partial<ConstructorParameters<typeof Role>[0]>;
    gatewayRole?: Partial<ConstructorParameters<typeof Role>[0]>;
    runtime?: Partial<ConstructorParameters<typeof Runtime>[0]>;
    endpoint?: Partial<ConstructorParameters<typeof RuntimeEndpoint>[0]>;
    memory?: Partial<ConstructorParameters<typeof Memory>[0]>;
    gateway?: Partial<ConstructorParameters<typeof BedrockAgentCoreGateway>[0]>;
    gatewayTarget?: Partial<ConstructorParameters<typeof GatewayTarget>[0]>;
    workloadIdentity?: Partial<ConstructorParameters<typeof WorkloadIdentity>[0]>;
  };
}

export type AgentCoreAgentResult = {
  role: InstanceType<typeof Role>;
  gatewayRole: InstanceType<typeof Role>;
  runtime: InstanceType<typeof Runtime>;
  endpoint: InstanceType<typeof RuntimeEndpoint>;
  memory: InstanceType<typeof Memory>;
  workloadIdentity: InstanceType<typeof WorkloadIdentity>;
  gateway: InstanceType<typeof BedrockAgentCoreGateway>;
  gatewayTarget: InstanceType<typeof GatewayTarget>;
};

/**
 * A Bedrock AgentCore agent as one CloudFormation-serializable bundle — the
 * composite/base path from #882: `Runtime` + `RuntimeEndpoint` + `Memory` +
 * `Gateway`/`GatewayTarget` + `WorkloadIdentity` + IAM, deployable with
 * `cfn-deploy` + `wait-for-stack` and no bespoke verb.
 *
 * `WorkloadIdentityDetails` on both `Runtime` and `BedrockAgentCoreGateway`
 * is CFN `readOnly` — AWS provisions a workload identity per resource
 * automatically, and neither accepts one as an input. The `WorkloadIdentity`
 * resource this composite creates is therefore standalone (not cross-wired
 * to `runtime`/`gateway`), included because #882 calls for it — it exists
 * for workflows (e.g. a future credential-provider capability) that need an
 * explicit workload identity of their own.
 *
 * The `agentcore-deploy` version-promotion capability that would repoint
 * `endpoint`'s `TargetVersion`/`LiveVersion` is deferred (GA-gated, #882) —
 * this composite only wires the CloudFormation shape it would eventually
 * apply against.
 */
export const AgentCoreAgent = Composite<AgentCoreAgentProps, AgentCoreAgentResult>((props) => {
  const { defaults } = props;
  const networkMode = props.networkMode ?? "PUBLIC";
  if (networkMode === "VPC" && (props.vpcSubnetIds === undefined || props.vpcSecurityGroupIds === undefined)) {
    throw new Error("AgentCoreAgent requires vpcSubnetIds and vpcSecurityGroupIds when networkMode is \"VPC\"");
  }
  const memoryEventExpiryDays = props.memoryEventExpiryDays ?? 30;
  if (memoryEventExpiryDays < 3 || memoryEventExpiryDays > 365) {
    throw new Error("AgentCoreAgent memoryEventExpiryDays must be between 3 and 365");
  }

  const runtimeName = toRuntimeIdentifier(props.name);

  // Runtime + Memory share one execution role — both are AgentCore-hosted
  // and assume the same service principal (see agentcore-trust-policy.ts).
  const role = new Role(mergeDefaults({
    AssumeRolePolicyDocument: agentCoreTrustPolicy,
    ManagedPolicyArns: props.ManagedPolicyArns,
    Policies: props.Policies,
  }, defaults?.role));

  // Gateway assumes its own role to invoke targets (e.g. this agent's own
  // Runtime endpoint) — kept separate from the Runtime/Memory role so its
  // permissions don't have to grow with the agent's own execution needs.
  const gatewayRole = new Role(mergeDefaults({
    AssumeRolePolicyDocument: agentCoreTrustPolicy,
  }, defaults?.gatewayRole));

  const networkConfiguration = new Runtime_NetworkConfiguration({
    NetworkMode: networkMode,
    NetworkModeConfig: networkMode === "VPC"
      ? new Runtime_VpcConfig({
        SecurityGroups: props.vpcSecurityGroupIds,
        Subnets: props.vpcSubnetIds,
      })
      : undefined,
  });

  const runtime = new Runtime(mergeDefaults({
    AgentRuntimeName: runtimeName,
    AgentRuntimeArtifact: new Runtime_AgentRuntimeArtifact({
      ContainerConfiguration: new Runtime_ContainerConfiguration({
        ContainerUri: props.containerUri,
      }),
    }),
    RoleArn: role.Arn,
    NetworkConfiguration: networkConfiguration,
    ProtocolConfiguration: props.protocolConfiguration ?? "MCP",
    EnvironmentVariables: props.environmentVariables,
  }, defaults?.runtime));

  const endpoint = new RuntimeEndpoint(mergeDefaults({
    AgentRuntimeId: runtime.AgentRuntimeId,
    Name: toRuntimeIdentifier(props.endpointName ?? "DEFAULT"),
  }, defaults?.endpoint));

  const memory = new Memory(mergeDefaults({
    Name: `${runtimeName}Memory`.slice(0, 48),
    EventExpiryDuration: memoryEventExpiryDays,
    MemoryExecutionRoleArn: role.Arn,
  }, defaults?.memory));

  const workloadIdentity = new WorkloadIdentity(mergeDefaults({
    Name: `${props.name}-identity`,
    AllowedResourceOauth2ReturnUrls: props.allowedResourceOauth2ReturnUrls,
  }, defaults?.workloadIdentity));

  const gateway = new BedrockAgentCoreGateway(mergeDefaults({
    Name: `${props.name}-gateway`,
    AuthorizerType: props.gatewayAuthorizerType ?? "AWS_IAM",
    RoleArn: gatewayRole.Arn,
  }, defaults?.gateway));

  // Default target: route the gateway's MCP tools straight back to this
  // agent's own Runtime endpoint (the shape Gateway's HTTP/AgentcoreRuntime
  // target configuration exists for). Override `defaults.gatewayTarget` to
  // point at a Lambda/OpenAPI/other target instead.
  const gatewayTarget = new GatewayTarget(mergeDefaults({
    GatewayIdentifier: gateway.GatewayIdentifier,
    Name: `${props.name}-target`,
    TargetConfiguration: {
      Http: {
        AgentcoreRuntime: { Arn: runtime.AgentRuntimeArn },
      },
    },
  }, defaults?.gatewayTarget));

  return { role, gatewayRole, runtime, endpoint, memory, workloadIdentity, gateway, gatewayTarget };
}, "AgentCoreAgent");
