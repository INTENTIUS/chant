// Parameter
export { Parameter } from "./parameter";

// Default Tags
export { defaultTags, isDefaultTags, DEFAULT_TAGS_MARKER } from "./default-tags";
export type { DefaultTags, TagEntry } from "./default-tags";
export { templateTransform, isTemplateTransform, TEMPLATE_TRANSFORM_MARKER } from "./template-transform";
export type { TemplateTransform } from "./template-transform";

// Serializer
export { awsSerializer } from "./serializer";

// Nested Stacks
export { nestedStack, isNestedStackInstance, NestedStackOutputRef, isNestedStackOutputRef, NESTED_STACK_MARKER } from "./nested-stack";
export type { NestedStackOptions, NestedStackInstance } from "./nested-stack";

// Re-export core child project, stack output, and lexicon output primitives
export { isChildProject, CHILD_PROJECT_MARKER } from "@intentius/chant/child-project";
export type { ChildProjectInstance } from "@intentius/chant/child-project";
export { stackOutput, isStackOutput, STACK_OUTPUT_MARKER } from "@intentius/chant/stack-output";
export type { StackOutput } from "@intentius/chant/stack-output";
export { output, isLexiconOutput } from "@intentius/chant/lexicon-output";
export type { LexiconOutput } from "@intentius/chant/lexicon-output";

// Plugin
export { awsPlugin } from "./plugin";

// Deep observation (#1015): the Cloud Control reader and the noise rules it
// shares with core's normalization pass.
export {
  observeResourcesDeepAws,
  awsDeepNormalizationHooks,
  hasOwnershipMarker,
  DEEP_READABLE_TYPES,
  AWS_READ_ONLY_NAMES,
  AWS_SERVICE_DEFAULTS,
} from "./deep-observe";

// The native read transport (#1206) — the applier's own transport, pointed at
// CloudFormation Query and Cloud Control. `parseCloudControlResource` used to
// live in ./deep-observe and parsed AWS CLI stdout; the reader no longer speaks
// that wire format, so `parseResourceDescription` (which takes the API's own
// `ResourceDescription` object) replaces it.
export {
  describeStackResources,
  describeStackOutputs,
  getResource,
  listResources,
  parseResourceDescription,
  AwsReadError,
  type AwsReadHttp,
  type AwsReadClientOptions,
  type CloudControlDescription,
  type StackResource,
} from "./api/read-client";

// Intrinsics
export {
  Sub,
  Ref,
  GetAtt,
  If,
  Join,
  Select,
  Split,
  Base64,
  GetAZs,
  SubIntrinsic,
  RefIntrinsic,
  GetAttIntrinsic,
  IfIntrinsic,
  JoinIntrinsic,
  SelectIntrinsic,
  SplitIntrinsic,
  Base64Intrinsic,
  GetAZsIntrinsic,
} from "./intrinsics";

// Pseudo-parameters
export {
  AWS,
  StackName,
  Region,
  AccountId,
  StackId,
  URLSuffix,
  NoValue,
  NotificationARNs,
  Partition,
} from "./pseudo";

// Generated resources — export everything from generated index
// After running `chant generate`, this re-exports all 1000+ resource classes
export * from "./generated/index";

// Spec utilities (for tooling)
export { fetchSchemaZip } from "./spec/fetch";
export type { CFNSchema, SchemaProperty, SchemaDefinition } from "./spec/fetch";
export { parseCFNSchema, cfnShortName, cfnServiceName } from "./spec/parse";
export type { SchemaParseResult, ParsedResource, ParsedProperty, ParsedAttribute, ParsedPropertyType, ParsedEnum, PropertyConstraints } from "./spec/parse";

// Action constants
export { S3Actions, LambdaActions, DynamoDBActions, SQSActions, SNSActions, IAMActions, ECRActions, LogsActions, ECSActions } from "./actions/index";

// Built-in composites
export {
  LambdaFunction, LambdaNode, LambdaPython, NodeLambda, PythonLambda,
  LambdaApi,
  LambdaScheduled, ScheduledLambda,
  LambdaSqs, LambdaEventBridge, LambdaDynamoDB, LambdaS3, LambdaSns,
  VpcDefault, FargateAlb, AlbShared, FargateService, RdsInstance, RdsPostgres,
  EfsWithAccessPoint,
  Ec2InstanceRole, MinimalVpc, EksCluster,
  SolrFargateService,
  MicrovmApp, MICROVM_LIMITS,
  AgentCoreAgent,
  OrganizationRoot, GovernanceFoundation, RegionRestriction, OrganizationTrail,
} from "./composites/index";
export type {
  LambdaFunctionProps, LambdaApiProps, ScheduledLambdaProps,
  LambdaSqsProps, LambdaEventBridgeProps, LambdaDynamoDBProps, LambdaS3Props, LambdaSnsProps,
  VpcDefaultProps, FargateAlbProps, AlbSharedProps, FargateServiceProps, RdsInstanceProps, RdsPostgresProps,
  EfsWithAccessPointProps,
  Ec2InstanceRoleProps, MinimalVpcProps, EksClusterProps,
  SolrFargateServiceProps,
  MicrovmAppProps, MicrovmAppResult, MicrovmAppBuildConnectorProps, MicrovmMemoryMiB,
  AgentCoreAgentProps, AgentCoreAgentResult,
  OrganizationRootProps, GovernanceFoundationProps, RegionRestrictionProps, OrganizationTrailProps,
} from "./composites/index";

// Code generation pipeline
export { generate, writeGeneratedFiles } from "./codegen/generate";
export { packageLexicon } from "./codegen/package";
export type { PackageOptions, PackageResult } from "./codegen/package";

// Component/release capabilities — the AWS operational leaves (cfn-deploy,
// emr-*, code-deploy, …) contributed to core's capability-plugin seam. Core
// loads `awsCapabilityPlugin` when a project's chant.config lists this lexicon.
export { awsCapabilityPlugin } from "./components/capability-plugin";

// AWS governance authoring (#791): the desired-state config the AWS cloud
// warden (#792) reconciles, and the typed landing-zone authoring layer.
export { landingZoneConfig, regionRestriction, DENY_AUDIT_TAMPER, DENY_LEAVE_ORGANIZATION, FOUNDATION_OUS } from "./governance";
export type { AwsGovernanceConfig, LandingZoneConfigProps, OuConfig, ScpConfig, AccountConfig } from "./governance";
