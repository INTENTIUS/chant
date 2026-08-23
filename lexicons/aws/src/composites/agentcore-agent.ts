import { Composite, mergeDefaults } from "@intentius/chant";
import {
  Role,
  Role_Policy,
  Runtime,
  Runtime_AgentRuntimeArtifact,
  Runtime_Code,
  Runtime_CodeConfiguration,
  Runtime_ContainerConfiguration,
  Runtime_NetworkConfiguration,
  Runtime_VpcConfig,
  RuntimeEndpoint,
  Memory,
  BedrockAgentCoreGateway,
  GatewayTarget,
  WorkloadIdentity,
} from "../generated";

/**
 * Managed language runtimes AgentCore can run a code-config zip on. Inlined
 * from the generated `Runtime_AgentManagedRuntimeType` CFN enum (which the
 * generated barrel exports as a type declaration only), matching how
 * `protocolConfiguration`/`gatewayAuthorizerType` inline their enums below.
 */
export type AgentManagedRuntime =
  | "NODE_22"
  | "PYTHON_3_10"
  | "PYTHON_3_11"
  | "PYTHON_3_12"
  | "PYTHON_3_13"
  | "PYTHON_3_14";
import { agentCoreTrustPolicy } from "./agentcore-trust-policy";
import { Sub, type SubIntrinsic } from "../intrinsics";

/**
 * ARN of the managed `DEFAULT` endpoint AgentCore provisions with a Runtime,
 * as an `Fn::Sub` over the Runtime's ARN. No CloudFormation attribute carries
 * it (the Runtime schema exposes only `AgentRuntimeArn`/`AgentRuntimeId`/
 * `AgentRuntimeVersion`/`Status`), but the format is fixed by the
 * CreateAgentRuntimeEndpoint API:
 * `arn:aws:bedrock-agentcore:<region>:<account>:runtime/<id>/runtime-endpoint/<name>`.
 */
export function agentCoreDefaultEndpointArn(runtime: InstanceType<typeof Runtime>): SubIntrinsic {
  return Sub`${runtime.AgentRuntimeArn}/runtime-endpoint/DEFAULT`;
}

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

/**
 * Managed-runtime code artifact — the S3-zip alternative to `containerUri`.
 * Mirrors CFN `Runtime.CodeConfiguration`: AgentCore runs a zipped agent on
 * a managed language runtime, no container image to build or host. This is
 * how a Strands agent actually ships (a Python zip in S3), which is why the
 * composite offers it alongside the container path.
 */
export interface AgentCoreCodeArtifact {
  /** S3 bucket holding the agent's zipped code. */
  s3Bucket: string;
  /** S3 key (or prefix) of the zip within `s3Bucket`. */
  s3Prefix: string;
  /** Optional S3 object version id, pinning a specific upload. */
  s3VersionId?: string;
  /** Managed runtime the zip runs on, e.g. `"PYTHON_3_12"`. Mirrors the generated CFN enum. */
  runtime: AgentManagedRuntime;
  /** Entry point, 1-2 items — e.g. `["app.py"]` or `["python", "app.py"]` (CFN bounds the list to 2). */
  entryPoint: string[];
}

export interface AgentCoreAgentProps {
  /**
   * Base name for the agent's resources. `toRuntimeIdentifier(name)` derives
   * the Runtime/Memory (and any explicit endpoint) names; Gateway/GatewayTarget/
   * WorkloadIdentity use `name` as-is (hyphens are valid there).
   */
  name: string;
  /**
   * ECR image URI the Runtime runs, e.g. `"123456789012.dkr.ecr.us-east-1.amazonaws.com/agent:latest"`.
   * Supply exactly one of `containerUri` or `code`.
   */
  containerUri?: string;
  /**
   * S3-zip code artifact run on a managed runtime — the alternative to
   * `containerUri`. Supply exactly one of the two.
   */
  code?: AgentCoreCodeArtifact;
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
  /**
   * Name of an explicit, non-`DEFAULT` `RuntimeEndpoint` to create alongside
   * the Runtime (e.g. `"PROD"`), the alias a version-promotion flow would
   * later repoint (deferred, see #882). Omit it and no endpoint resource is
   * created: AgentCore provisions a managed `DEFAULT` endpoint with every
   * Runtime, and it tracks the latest version on its own. `"DEFAULT"` is
   * rejected, since a CloudFormation endpoint of that name duplicates the
   * managed one and fails on a real apply (#978, see the composite doc).
   */
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
  /** Present only when `endpointName` names an explicit non-DEFAULT endpoint (#978). */
  endpoint?: InstanceType<typeof RuntimeEndpoint>;
  memory: InstanceType<typeof Memory>;
  workloadIdentity: InstanceType<typeof WorkloadIdentity>;
  gateway: InstanceType<typeof BedrockAgentCoreGateway>;
  gatewayTarget: InstanceType<typeof GatewayTarget>;
};

/**
 * A Bedrock AgentCore agent as one CloudFormation-serializable bundle — the
 * composite/base path from #882: `Runtime` + `Memory` +
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
 * There is no `RuntimeEndpoint` in the bundle by default. AgentCore creates a
 * managed `DEFAULT` endpoint with every Runtime and repoints it at each new
 * version on its own, so a CloudFormation `DEFAULT` endpoint is redundant. It
 * is also the race that sank a live deploy (#978): the Runtime resource's
 * `CREATE_COMPLETE` fires while AgentCore is still turning the artifact into
 * a READY agent version, and the endpoint's CREATE then fails with "Agent
 * version 1 must be in READY status". Invoking the Runtime with no qualifier
 * hits the managed DEFAULT endpoint; {@link agentCoreDefaultEndpointArn}
 * builds its ARN from the Runtime's. `endpointName` adds an explicit
 * non-DEFAULT endpoint for the `agentcore-deploy` version-promotion flow,
 * which is deferred (GA-gated, #882) — this composite only wires the
 * CloudFormation shape it would eventually apply against.
 */
export const AgentCoreAgent = Composite<AgentCoreAgentProps, AgentCoreAgentResult>((props) => {
  const { defaults } = props;
  // Exactly one artifact source. Both-or-neither is a modeling mistake CFN
  // would also reject (AgentRuntimeArtifact is a one-of), caught here so the
  // error names the composite prop rather than a raw CFN validation string.
  if ((props.containerUri === undefined) === (props.code === undefined)) {
    throw new Error("AgentCoreAgent requires exactly one of containerUri or code");
  }
  const networkMode = props.networkMode ?? "PUBLIC";
  // Check presence, not `.length`: a cross-stack value (Fn::Split of a Parameter,
  // the shape stackOutput/Ref/Split produce) is a truthy intrinsic object with no
  // `.length`, so a `.length` check wrongly rejects a value that WAS supplied
  // (#938). An actually-empty list is caught by CloudFormation at deploy time.
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

  // CFN `Code.S3` is a free-form location object in the generated type; its
  // keys (Bucket/Prefix/VersionId) come straight from the CloudFormation
  // schema for AWS::BedrockAgentCore::Runtime.
  const artifact = props.code
    ? new Runtime_AgentRuntimeArtifact({
      CodeConfiguration: new Runtime_CodeConfiguration({
        Code: new Runtime_Code({
          S3: {
            Bucket: props.code.s3Bucket,
            Prefix: props.code.s3Prefix,
            ...(props.code.s3VersionId !== undefined ? { VersionId: props.code.s3VersionId } : {}),
          },
        }),
        EntryPoint: props.code.entryPoint,
        Runtime: props.code.runtime,
      }),
    })
    : new Runtime_AgentRuntimeArtifact({
      ContainerConfiguration: new Runtime_ContainerConfiguration({
        ContainerUri: props.containerUri as string,
      }),
    });

  const runtime = new Runtime(mergeDefaults({
    AgentRuntimeName: runtimeName,
    AgentRuntimeArtifact: artifact,
    RoleArn: role.Arn,
    NetworkConfiguration: networkConfiguration,
    ProtocolConfiguration: props.protocolConfiguration ?? "MCP",
    EnvironmentVariables: props.environmentVariables,
  }, defaults?.runtime));

  // Explicit endpoints only for a non-DEFAULT alias (#978): AgentCore owns
  // DEFAULT, and creating it here races the Runtime's async version-READY.
  if (props.endpointName === "DEFAULT") {
    throw new Error("AgentCoreAgent endpointName must not be \"DEFAULT\": AgentCore provisions the managed DEFAULT endpoint itself");
  }
  const endpoint = props.endpointName !== undefined
    ? new RuntimeEndpoint(mergeDefaults({
        AgentRuntimeId: runtime.AgentRuntimeId,
        Name: toRuntimeIdentifier(props.endpointName),
      }, defaults?.endpoint))
    : undefined;

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

  return { role, gatewayRole, runtime, ...(endpoint ? { endpoint } : {}), memory, workloadIdentity, gateway, gatewayTarget };
}, "AgentCoreAgent");
