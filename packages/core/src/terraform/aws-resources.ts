/**
 * The AWS carve-out resource table — the single source of truth for which AWS
 * Terraform types chant can carve, and how.
 *
 * Both the advisor (tier map / scoring) and `carve emit --state` derive from
 * this one list, so advise and emit cover exactly the same AWS types: advise
 * never ranks a resource emit cannot produce, and emit never claims a type
 * advise did not score. Adding a type here lights it up for both at once.
 *
 * Each entry maps the common, high-confidence Terraform attributes to their
 * CloudFormation property names (chant AWS constructors take CFN PascalCase
 * props). Attributes without a mapping here are preserved in a reference
 * comment on emit, never dropped — a curated seed, not a full TF↔CFN transform.
 */

/** A Terraform attribute → CloudFormation property mapping. */
type FieldSpec = string | { prop: string; transform: (v: unknown) => unknown };

export interface AwsCarveType {
  /** Terraform resource type, e.g. `aws_s3_bucket`. */
  tfType: string;
  /** Native-spec map tier: 1 clean 1:1, 2 some reshaping, 3 heavy composite. */
  tier: 1 | 2 | 3;
  /** CloudFormation type, e.g. `AWS::S3::Bucket`. */
  nativeType: string;
  /** chant AWS lexicon constructor, e.g. `Bucket` (verified against generated exports). */
  ctor: string;
  /** The HCL attribute carrying the physical name (for the live-import hint / graph identity). */
  identityAttr?: string;
  /** Terraform attribute → CFN property mappings. */
  fields: Record<string, FieldSpec>;
  /** Map the Terraform `tags` map to CloudFormation `Tags` list. */
  tags?: boolean;
}

export const AWS_LEXICON_IMPORT = "@intentius/chant-lexicon-aws";

/** Parse a Terraform JSON-string attribute (IAM policy docs) into an object. */
const asJson = (v: unknown): unknown => {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};
const json = (prop: string): FieldSpec => ({ prop, transform: asJson });

export const AWS_CARVE_TYPES: AwsCarveType[] = [
  // ── Storage & data ──
  { tfType: "aws_s3_bucket", tier: 1, nativeType: "AWS::S3::Bucket", ctor: "Bucket", identityAttr: "bucket",
    fields: { bucket: "BucketName" }, tags: true },
  { tfType: "aws_dynamodb_table", tier: 2, nativeType: "AWS::DynamoDB::Table", ctor: "Table", identityAttr: "name",
    fields: { name: "TableName", billing_mode: "BillingMode" }, tags: true },
  { tfType: "aws_efs_file_system", tier: 1, nativeType: "AWS::EFS::FileSystem", ctor: "EFSFileSystem",
    fields: { encrypted: "Encrypted", performance_mode: "PerformanceMode", throughput_mode: "ThroughputMode" }, tags: true },

  // ── Messaging ──
  { tfType: "aws_sns_topic", tier: 1, nativeType: "AWS::SNS::Topic", ctor: "Topic", identityAttr: "name",
    fields: { name: "TopicName", display_name: "DisplayName", fifo_topic: "FifoTopic" }, tags: true },
  { tfType: "aws_sqs_queue", tier: 1, nativeType: "AWS::SQS::Queue", ctor: "Queue", identityAttr: "name",
    fields: { name: "QueueName", visibility_timeout_seconds: "VisibilityTimeout", fifo_queue: "FifoQueue", delay_seconds: "DelaySeconds" }, tags: true },

  // ── IAM ──
  { tfType: "aws_iam_role", tier: 2, nativeType: "AWS::IAM::Role", ctor: "Role", identityAttr: "name",
    fields: { name: "RoleName", assume_role_policy: json("AssumeRolePolicyDocument"), managed_policy_arns: "ManagedPolicyArns", description: "Description", path: "Path" }, tags: true },
  { tfType: "aws_iam_policy", tier: 1, nativeType: "AWS::IAM::ManagedPolicy", ctor: "ManagedPolicy", identityAttr: "name",
    fields: { name: "ManagedPolicyName", policy: json("PolicyDocument"), description: "Description", path: "Path" } },
  { tfType: "aws_iam_instance_profile", tier: 1, nativeType: "AWS::IAM::InstanceProfile", ctor: "InstanceProfile", identityAttr: "name",
    fields: { name: "InstanceProfileName", path: "Path", role: { prop: "Roles", transform: (v) => (v === undefined ? v : [v]) } } },

  // ── Registry, keys, secrets, config ──
  { tfType: "aws_ecr_repository", tier: 1, nativeType: "AWS::ECR::Repository", ctor: "ECRRepository", identityAttr: "name",
    fields: { name: "RepositoryName", image_tag_mutability: "ImageTagMutability" }, tags: true },
  { tfType: "aws_kms_key", tier: 2, nativeType: "AWS::KMS::Key", ctor: "KmsKey",
    fields: { description: "Description", enable_key_rotation: "EnableKeyRotation", deletion_window_in_days: "PendingWindowInDays", is_enabled: "Enabled" }, tags: true },
  { tfType: "aws_secretsmanager_secret", tier: 1, nativeType: "AWS::SecretsManager::Secret", ctor: "Secret", identityAttr: "name",
    fields: { name: "Name", description: "Description", kms_key_id: "KmsKeyId" }, tags: true },
  { tfType: "aws_ssm_parameter", tier: 1, nativeType: "AWS::SSM::Parameter", ctor: "SsmParameter", identityAttr: "name",
    fields: { name: "Name", type: "Type", value: "Value", tier: "Tier", description: "Description" } },

  // ── Compute ──
  { tfType: "aws_lambda_function", tier: 2, nativeType: "AWS::Lambda::Function", ctor: "Function", identityAttr: "function_name",
    fields: { function_name: "FunctionName", runtime: "Runtime", handler: "Handler", memory_size: "MemorySize", timeout: "Timeout", description: "Description", architectures: "Architectures" }, tags: true },
  { tfType: "aws_ecs_service", tier: 3, nativeType: "AWS::ECS::Service", ctor: "EcsService", identityAttr: "name",
    fields: { name: "ServiceName", cluster: "Cluster", desired_count: "DesiredCount", launch_type: "LaunchType", task_definition: "TaskDefinition" }, tags: true },

  // ── Networking ──
  { tfType: "aws_vpc", tier: 1, nativeType: "AWS::EC2::VPC", ctor: "Vpc",
    fields: { cidr_block: "CidrBlock", enable_dns_support: "EnableDnsSupport", enable_dns_hostnames: "EnableDnsHostnames", instance_tenancy: "InstanceTenancy" }, tags: true },
  { tfType: "aws_subnet", tier: 1, nativeType: "AWS::EC2::Subnet", ctor: "Subnet",
    fields: { vpc_id: "VpcId", cidr_block: "CidrBlock", availability_zone: "AvailabilityZone", map_public_ip_on_launch: "MapPublicIpOnLaunch" }, tags: true },
  { tfType: "aws_security_group", tier: 2, nativeType: "AWS::EC2::SecurityGroup", ctor: "SecurityGroup", identityAttr: "name",
    fields: { description: "GroupDescription", name: "GroupName", vpc_id: "VpcId" }, tags: true },
  { tfType: "aws_route_table", tier: 2, nativeType: "AWS::EC2::RouteTable", ctor: "RouteTable",
    fields: { vpc_id: "VpcId" }, tags: true },
  { tfType: "aws_internet_gateway", tier: 1, nativeType: "AWS::EC2::InternetGateway", ctor: "InternetGateway",
    fields: {}, tags: true },
  { tfType: "aws_eip", tier: 1, nativeType: "AWS::EC2::EIP", ctor: "EIP",
    fields: { domain: "Domain", instance: "InstanceId" }, tags: true },
  { tfType: "aws_nat_gateway", tier: 2, nativeType: "AWS::EC2::NatGateway", ctor: "NatGateway",
    fields: { subnet_id: "SubnetId", allocation_id: "AllocationId", connectivity_type: "ConnectivityType" }, tags: true },

  // ── DNS & observability ──
  { tfType: "aws_route53_zone", tier: 1, nativeType: "AWS::Route53::HostedZone", ctor: "HostedZone", identityAttr: "name",
    fields: { name: "Name", comment: "HostedZoneConfig" } },
  { tfType: "aws_cloudwatch_log_group", tier: 1, nativeType: "AWS::Logs::LogGroup", ctor: "LogGroup", identityAttr: "name",
    fields: { name: "LogGroupName", retention_in_days: "RetentionInDays", kms_key_id: "KmsKeyId" }, tags: true },
  { tfType: "aws_cloudwatch_metric_alarm", tier: 2, nativeType: "AWS::CloudWatch::Alarm", ctor: "Alarm", identityAttr: "alarm_name",
    fields: { alarm_name: "AlarmName", comparison_operator: "ComparisonOperator", metric_name: "MetricName", namespace: "Namespace", threshold: "Threshold", evaluation_periods: "EvaluationPeriods", period: "Period", statistic: "Statistic", alarm_description: "AlarmDescription" }, tags: true },
];

const BY_TYPE = new Map(AWS_CARVE_TYPES.map((t) => [t.tfType, t]));

export function awsCarveType(tfType: string): AwsCarveType | undefined {
  return BY_TYPE.get(tfType);
}

/** TF `tags` map → CloudFormation `Tags` list of {Key, Value}. */
function tagsToCfn(tags: unknown): Array<{ Key: string; Value: unknown }> | undefined {
  if (!tags || typeof tags !== "object" || Array.isArray(tags)) return undefined;
  const entries = Object.entries(tags as Record<string, unknown>);
  return entries.length ? entries.map(([Key, Value]) => ({ Key, Value })) : undefined;
}

/**
 * Apply an entry's field mappings to a resource's Terraform attributes, yielding
 * CloudFormation properties and the set of attribute keys that were consumed
 * (so the caller can report the rest as unmapped).
 */
export function applyAwsMapper(
  entry: AwsCarveType,
  attrs: Record<string, unknown>,
): { props: Record<string, unknown>; mappedKeys: string[] } {
  const props: Record<string, unknown> = {};
  const mappedKeys: string[] = ["id", "arn"]; // identity/computed attrs, ignored not dropped
  for (const [tfAttr, spec] of Object.entries(entry.fields)) {
    const value = attrs[tfAttr];
    if (value === undefined) continue;
    if (typeof spec === "string") {
      props[spec] = value;
    } else {
      const t = spec.transform(value);
      if (t !== undefined) props[spec.prop] = t;
    }
    mappedKeys.push(tfAttr);
  }
  if (entry.tags) {
    const tags = tagsToCfn(attrs.tags);
    if (tags) props.Tags = tags;
    mappedKeys.push("tags");
  }
  return { props, mappedKeys };
}
