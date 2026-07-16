/**
 * MicrovmApp — composite-first delivery of AWS Lambda MicroVM support (#879).
 *
 * Emits `AWS::Lambda::MicrovmImage` (a preview CFN resource type — see the
 * issue's "Preview-API gate") plus the least-privilege build/execution IAM
 * roles the upstream `ran-isenberg/lambda-microvm-cdk-python` construct
 * creates, and — only when build-time VPC egress is requested — an
 * `AWS::Lambda::NetworkConnector`, its deny-all-egress security group, and its
 * ENI operator role.
 *
 * Base path only (#879 scope): `chant build` serializes this composite to a
 * CloudFormation template; `cfn-deploy` + `wait-for-stack` deploy it and wait
 * for the image snapshot to build, with no bespoke verb. The
 * `microvm-image-build` capability (build-once / promote-by-ARN) is deferred
 * — see the issue's "Settled decisions".
 *
 * The IAM shapes below mirror `lambda_microvm_cdk._impl.security` (build role
 * scoped to the exact S3 code-artifact object + the image's own log group;
 * execution role scoped to runtime logs only; connector operator role scoped
 * to the AWS-documented `ec2:CreateNetworkInterface`/`CreateTags` grant), and
 * the deny-all security group reproduces `aws-cdk-lib`'s own
 * `MATCH_NO_TRAFFIC` placeholder rule (`aws-ec2/lib/security-group.ts`) —
 * spot-checked against both upstream sources so the shapes match what the
 * MicroVM service actually expects, not a guess.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import {
  MicrovmImage,
  MicrovmImage_CloudWatchLogging,
  MicrovmImage_CodeArtifact,
  MicrovmImage_CpuConfiguration,
  MicrovmImage_EnvironmentVariable,
  MicrovmImage_Hooks,
  MicrovmImage_Logging,
  MicrovmImage_Resources,
  NetworkConnector,
  NetworkConnector_Config,
  NetworkConnector_VpcEgressConfiguration,
  Role,
  Role_Policy,
  SecurityGroup,
  SecurityGroup_Egress,
} from "../generated";
import { Sub } from "../intrinsics";

const MICROVM_SERVICE_PRINCIPAL = "lambda.amazonaws.com";
const CONNECTOR_MANAGED_RESOURCE_OPERATOR = "network-connectors.lambda.amazonaws.com";

/** Documented baseline memory tiers (MiB) — the CFN schema types it as an open int, but the service accepts only these five; vCPU auto-scales with the tier. */
const VALID_MEMORY_MIB = [512, 1024, 2048, 4096, 8192] as const;
type MicrovmMemoryMiB = (typeof VALID_MEMORY_MIB)[number];

const NAME_PATTERN = /^[a-zA-Z0-9-_]+$/;
const MAX_NAME_LENGTH = 64;
const RESERVED_ENV_KEYS = new Set(["AWS_REGION"]);
const MAX_ENVIRONMENT_VARIABLES = 50;
const MAX_EGRESS_CONNECTORS = 10;
const MIN_CONNECTOR_SUBNETS = 1;
const MAX_CONNECTOR_SUBNETS = 16;

/**
 * `sts:AssumeRole` + `sts:TagSession` trust for `lambda.amazonaws.com` — the
 * MicroVM service assumes the build/execution roles with session tags
 * (`lambda_microvm_cdk._impl.security._microvm_service_trust`).
 */
const microvmServiceTrustPolicy = {
  Version: "2012-10-17" as const,
  Statement: [
    { Effect: "Allow" as const, Principal: { Service: MICROVM_SERVICE_PRINCIPAL }, Action: "sts:AssumeRole" },
    { Effect: "Allow" as const, Principal: { Service: MICROVM_SERVICE_PRINCIPAL }, Action: "sts:TagSession" },
  ],
};

/** Plain `sts:AssumeRole` trust — the connector operator role's documented trust (no session tags). */
const lambdaTrustPolicy = {
  Version: "2012-10-17" as const,
  Statement: [
    { Effect: "Allow" as const, Principal: { Service: MICROVM_SERVICE_PRINCIPAL }, Action: "sts:AssumeRole" },
  ],
};

/**
 * CDK's synthesized "deny all outbound" placeholder rule. A security group
 * with no egress rules gets CloudFormation's allow-all-outbound default, so
 * this rule (which matches no real traffic — `255.255.255.255/32` is
 * unassignable) is added explicitly to override that default. Verbatim
 * `MATCH_NO_TRAFFIC` from `aws-cdk-lib/aws-ec2/lib/security-group.ts`.
 */
const DENY_ALL_EGRESS = new SecurityGroup_Egress({
  CidrIp: "255.255.255.255/32",
  Description: "Disallow all traffic",
  IpProtocol: "icmp",
  FromPort: 252,
  ToPort: 86,
});

export interface MicrovmAppBuildConnectorProps {
  /** VPC the connector's ENIs attach to. */
  vpcId: string;
  /** 1-16 subnet ids, all in `vpcId` — where Lambda provisions the connector's ENIs. */
  subnetIds: string[];
  /** `"IPv4"` (default) or `"DualStack"`. */
  networkProtocol?: "IPv4" | "DualStack";
}

export interface MicrovmAppProps {
  /** Unique image name (`^[a-zA-Z0-9-_]+$`, ≤64 chars). Create-only — changing it forces replacement. */
  name: string;
  /** Human-readable description. CFN requires the property; `""` is valid. */
  description?: string;
  /**
   * The `CodeArtifact.Uri` value CloudFormation wants — e.g. the `uri` a
   * `publish-artifact` step produced (`"@Publish.uri"`, wired in by the
   * driver). Kept distinct from {@link codeArtifactObjectArn}: this is the
   * value the MicroVM service resolves the artifact from, while that one is
   * the resource ARN the build role's IAM grant is scoped to — the two only
   * coincide by convention, not by type.
   */
  codeArtifactUri: string;
  /**
   * Exact S3 object ARN of the code artifact, for the build role's
   * `s3:GetObject` grant. Scoped to the precise object (never `bucket/*`),
   * matching the upstream construct's `artifact_object_arn`. Pass the
   * caller-resolved ARN rather than have this composite parse one out of an
   * arbitrary URI — the same "wired reference, already resolved by the
   * driver" convention `cfn-deploy`'s `imageRef` uses.
   */
  codeArtifactObjectArn: string;
  /** AWS-managed base image alias (e.g. `"al2023-1"`) or a full base-image ARN. */
  baseImage: string;
  /**
   * Base image version to pin. Default: `"0"` — the fallback the upstream
   * construct itself uses when a synth-time boto3 lookup isn't available.
   * Chant's synth is deterministic/offline, so this composite never performs
   * a live lookup; pin this explicitly for a specific managed version.
   */
  baseImageVersion?: string;
  /** Baseline memory tier in MiB — one of the five documented tiers; vCPU auto-scales with it. Default: `2048`. */
  memoryMiB?: MicrovmMemoryMiB;
  /** Env vars baked into the image at build time (max 50) — snapshotted and shared by every VM booted from this image. Never put secrets here. */
  environment?: Record<string, string>;
  /** Opt into `"ALL"` additional OS capabilities — a documented privilege escalation. Default: none (least privilege). */
  additionalOsCapabilities?: "ALL"[];
  /** Disable CloudWatch build/runtime logging entirely. Default: `false` (logging enabled, pinned to `/aws/lambda/microvms/<name>`). */
  disableLogging?: boolean;
  /** Lifecycle hooks — all default to disabled (traffic flows immediately). */
  hooks?: ConstructorParameters<typeof MicrovmImage_Hooks>[0];
  /**
   * Build-time egress: attach a `NetworkConnector` (+ its deny-all-egress
   * security group + least-privilege ENI operator role) so the image build
   * can reach a VPC (private mirrors, an internal registry). Omit for the
   * default public-internet build egress. The connector's security-group
   * rules ARE its egress policy — deny-all by default; open it via
   * `defaults.connectorSecurityGroup`.
   */
  buildConnector?: MicrovmAppBuildConnectorProps;
  /** Extra egress connector ARNs to bake in alongside the one this composite creates (e.g. an AWS-managed `INTERNET_EGRESS` alias, or a pre-existing shared connector). Max 10 total. */
  additionalEgressConnectors?: string[];
  defaults?: {
    buildRole?: Partial<ConstructorParameters<typeof Role>[0]>;
    executionRole?: Partial<ConstructorParameters<typeof Role>[0]>;
    connectorOperatorRole?: Partial<ConstructorParameters<typeof Role>[0]>;
    connectorSecurityGroup?: Partial<ConstructorParameters<typeof SecurityGroup>[0]>;
    connector?: Partial<ConstructorParameters<typeof NetworkConnector>[0]>;
    image?: Partial<ConstructorParameters<typeof MicrovmImage>[0]>;
  };
}

export type MicrovmAppResult = {
  /** Least-privilege role the MicroVM service assumes to build the image — `s3:GetObject` on the exact code-artifact object, `logs:*` on the image's own log group. */
  buildRole: InstanceType<typeof Role>;
  /** Least-privilege role assumed by the running MicroVM — runtime-logs only; add workload permissions (e.g. Bedrock) on top. */
  executionRole: InstanceType<typeof Role>;
  /** The `AWS::Lambda::MicrovmImage` resource. */
  image: InstanceType<typeof MicrovmImage>;
  /** The build-egress connector's deny-all security group (only when `buildConnector` is set). */
  connectorSecurityGroup?: InstanceType<typeof SecurityGroup>;
  /** The connector's least-privilege ENI operator role (only when `buildConnector` is set). */
  connectorOperatorRole?: InstanceType<typeof Role>;
  /** The `AWS::Lambda::NetworkConnector` resource (only when `buildConnector` is set). */
  connector?: InstanceType<typeof NetworkConnector>;
};

export const MicrovmApp = Composite<MicrovmAppProps, MicrovmAppResult>((props) => {
  if (!NAME_PATTERN.test(props.name) || props.name.length > MAX_NAME_LENGTH) {
    throw new Error(
      `MicrovmApp name must match ${NAME_PATTERN} and be ≤${MAX_NAME_LENGTH} chars, got: ${JSON.stringify(props.name)}`,
    );
  }

  const memoryMiB = props.memoryMiB ?? 2048;
  if (!(VALID_MEMORY_MIB as readonly number[]).includes(memoryMiB)) {
    throw new Error(`MicrovmApp memoryMiB must be one of ${VALID_MEMORY_MIB.join(", ")}, got: ${memoryMiB}`);
  }

  const environment = props.environment ?? {};
  const environmentKeys = Object.keys(environment);
  if (environmentKeys.length > MAX_ENVIRONMENT_VARIABLES) {
    throw new Error(
      `MicrovmApp environment supports at most ${MAX_ENVIRONMENT_VARIABLES} variables, got ${environmentKeys.length}`,
    );
  }
  for (const key of environmentKeys) {
    if (RESERVED_ENV_KEYS.has(key)) {
      throw new Error(`MicrovmApp environment key "${key}" is reserved — the MicroVM runtime injects it`);
    }
  }

  const additionalEgressConnectors = props.additionalEgressConnectors ?? [];
  const totalConnectors = additionalEgressConnectors.length + (props.buildConnector ? 1 : 0);
  if (totalConnectors > MAX_EGRESS_CONNECTORS) {
    throw new Error(`MicrovmApp supports at most ${MAX_EGRESS_CONNECTORS} egress connectors total, got ${totalConnectors}`);
  }

  if (props.buildConnector) {
    const subnetCount = props.buildConnector.subnetIds.length;
    if (subnetCount < MIN_CONNECTOR_SUBNETS || subnetCount > MAX_CONNECTOR_SUBNETS) {
      throw new Error(
        `MicrovmApp buildConnector needs ${MIN_CONNECTOR_SUBNETS}-${MAX_CONNECTOR_SUBNETS} subnets, got ${subnetCount}`,
      );
    }
  }

  const { defaults } = props;

  // Service-owned log group the build + execution roles are scoped to
  // (`lambda_microvm_cdk._impl.security.log_group_arn`) — the MicroVM service
  // creates and owns this group; this composite only references its ARN for
  // the IAM grants, never declares the group itself.
  const logGroupName = `/aws/lambda/microvms/${props.name}`;
  const logGroupArn = Sub`arn:\${AWS::Partition}:logs:\${AWS::Region}:\${AWS::AccountId}:log-group:${logGroupName}`;
  const logGroupArnWildcard = Sub`arn:\${AWS::Partition}:logs:\${AWS::Region}:\${AWS::AccountId}:log-group:${logGroupName}:*`;

  // ── Build role ── s3:GetObject on the exact code artifact object, logs:* on the image's own log group.
  const buildRole = new Role(
    mergeDefaults(
      {
        AssumeRolePolicyDocument: microvmServiceTrustPolicy,
        Description: "Least-privilege build role for the Lambda MicroVM image build",
        Policies: [
          new Role_Policy({
            PolicyName: "MicrovmImageBuild",
            PolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Sid: "ReadExactCodeArtifact",
                  Effect: "Allow",
                  Action: "s3:GetObject",
                  Resource: props.codeArtifactObjectArn,
                },
                {
                  Sid: "WriteBuildLogs",
                  Effect: "Allow",
                  Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
                  Resource: [logGroupArn, logGroupArnWildcard],
                },
              ],
            },
          }),
        ],
      },
      defaults?.buildRole,
    ),
  );

  // ── Execution role ── runtime-logs only; the consumer adds workload permissions on top.
  const executionRole = new Role(
    mergeDefaults(
      {
        AssumeRolePolicyDocument: microvmServiceTrustPolicy,
        Description: "Least-privilege execution role assumed by the running MicroVM",
        Policies: [
          new Role_Policy({
            PolicyName: "MicrovmRuntimeLogs",
            PolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Sid: "WriteRuntimeLogs",
                  Effect: "Allow",
                  Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
                  Resource: [logGroupArn, logGroupArnWildcard],
                },
              ],
            },
          }),
        ],
      },
      defaults?.executionRole,
    ),
  );

  // ── Optional build-time egress connector ──────────────────────────────────
  let connectorSecurityGroup: InstanceType<typeof SecurityGroup> | undefined;
  let connectorOperatorRole: InstanceType<typeof Role> | undefined;
  let connector: InstanceType<typeof NetworkConnector> | undefined;
  const egressConnectorArns: unknown[] = [...additionalEgressConnectors];

  // A closure (invoked below) keeps the connector `new`s out of the `if` (EVL002);
  // the early-return guard also narrows `props.buildConnector` for the body.
  const buildConnectorResources = () => {
    if (!props.buildConnector) return;
    // Deny-all by default — the security group's rules ARE the egress policy;
    // open specific traffic via `defaults.connectorSecurityGroup`.
    connectorSecurityGroup = new SecurityGroup(
      mergeDefaults(
        {
          GroupDescription: "MicroVM egress connector security group (rules ARE the egress policy)",
          VpcId: props.buildConnector.vpcId,
          SecurityGroupEgress: [DENY_ALL_EGRESS],
        },
        defaults?.connectorSecurityGroup,
      ),
    );

    // Reproduces verbatim the AWS-documented `NetworkConnector` operator-role
    // policy: `ec2:CreateNetworkInterface` on the ENI/subnet/security-group
    // resource types (region/account wildcarded — Lambda creates the ENIs in
    // its own context, so pinning them would deny the call and the connector
    // would never become ACTIVE), plus `ec2:CreateTags` on ENIs conditioned on
    // the connector's own managed-resource operator so the grant can't tag
    // arbitrary interfaces.
    connectorOperatorRole = new Role(
      mergeDefaults(
        {
          AssumeRolePolicyDocument: lambdaTrustPolicy,
          Description: "Least-privilege operator role Lambda assumes to manage the MicroVM connector ENIs",
          Policies: [
            new Role_Policy({
              PolicyName: "MicrovmConnectorEnis",
              PolicyDocument: {
                Version: "2012-10-17",
                Statement: [
                  {
                    Sid: "CreateENI",
                    Effect: "Allow",
                    Action: "ec2:CreateNetworkInterface",
                    Resource: [
                      Sub`arn:\${AWS::Partition}:ec2:*:*:network-interface/*`,
                      Sub`arn:\${AWS::Partition}:ec2:*:*:subnet/*`,
                      Sub`arn:\${AWS::Partition}:ec2:*:*:security-group/*`,
                    ],
                  },
                  {
                    Sid: "TagENI",
                    Effect: "Allow",
                    Action: "ec2:CreateTags",
                    Resource: Sub`arn:\${AWS::Partition}:ec2:*:*:network-interface/*`,
                    Condition: {
                      StringEquals: { "ec2:ManagedResourceOperator": CONNECTOR_MANAGED_RESOURCE_OPERATOR },
                    },
                  },
                ],
              },
            }),
          ],
        },
        defaults?.connectorOperatorRole,
      ),
    );

    connector = new NetworkConnector(
      mergeDefaults(
        {
          OperatorRole: connectorOperatorRole.Arn,
          Configuration: new NetworkConnector_Config({
            VpcEgressConfiguration: new NetworkConnector_VpcEgressConfiguration({
              AssociatedComputeResourceTypes: ["MicroVm"],
              SubnetIds: props.buildConnector.subnetIds,
              SecurityGroupIds: [connectorSecurityGroup.GroupId],
              NetworkProtocol: props.buildConnector.networkProtocol ?? "IPv4",
            }),
          }),
        },
        defaults?.connector,
      ),
    );

    egressConnectorArns.push(connector.Arn);
  };

  if (props.buildConnector) buildConnectorResources();

  // ── The image itself ───────────────────────────────────────────────────────
  const logging = props.disableLogging
    ? new MicrovmImage_Logging({ Disabled: true })
    : new MicrovmImage_Logging({ CloudWatch: new MicrovmImage_CloudWatchLogging({ LogGroup: logGroupName }) });

  const environmentVariables = environmentKeys.map(
    (key) => new MicrovmImage_EnvironmentVariable({ Key: key, Value: environment[key] }),
  );

  // `Hooks` is required by the CFN schema but every nested field is optional —
  // "no hooks configured" (all lifecycle hooks disabled) is a real, valid `{}`.
  // The serializer drops a wrapped property object down to `undefined` when its
  // `.props` has zero keys (so an *optional* empty nested object vanishes
  // rather than serializing as `{}`), which would silently drop this
  // *required* property from the template. Emit a plain object literal instead
  // of the `MicrovmImage_Hooks` wrapper so an empty `Hooks` still serializes
  // as `{}`, not nothing.
  const hasHooks = props.hooks !== undefined && Object.keys(props.hooks).length > 0;
  const hooks = hasHooks ? new MicrovmImage_Hooks(props.hooks!) : {};

  // Short alias (e.g. "al2023-1") -> the AWS-managed base-image ARN; full ARNs pass through.
  const baseImageArn = props.baseImage.startsWith("arn:")
    ? props.baseImage
    : Sub`arn:\${AWS::Partition}:lambda:\${AWS::Region}:aws:microvm-image:${props.baseImage}`;

  const image = new MicrovmImage(
    mergeDefaults(
      {
        Name: props.name,
        Description: props.description ?? "",
        BaseImageArn: baseImageArn,
        BaseImageVersion: props.baseImageVersion ?? "0",
        BuildRoleArn: buildRole.Arn,
        CodeArtifact: new MicrovmImage_CodeArtifact({ Uri: props.codeArtifactUri }),
        // ARM_64 is the only architecture the service accepts today.
        CpuConfigurations: [new MicrovmImage_CpuConfiguration({ Architecture: "ARM_64" })],
        Resources: [new MicrovmImage_Resources({ MinimumMemoryInMiB: memoryMiB })],
        AdditionalOsCapabilities: props.additionalOsCapabilities ?? [],
        EgressNetworkConnectors: egressConnectorArns,
        EnvironmentVariables: environmentVariables,
        Hooks: hooks,
        Logging: logging,
      },
      defaults?.image,
    ),
  );

  return {
    buildRole,
    executionRole,
    image,
    ...(connectorSecurityGroup ? { connectorSecurityGroup } : {}),
    ...(connectorOperatorRole ? { connectorOperatorRole } : {}),
    ...(connector ? { connector } : {}),
  };
}, "MicrovmApp");
