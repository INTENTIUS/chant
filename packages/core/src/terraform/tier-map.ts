/**
 * Terraform-type → native-spec tier map for the carve-out advisor (#214 T3).
 *
 * Peelability scoring needs to know, per Terraform resource type, how cleanly it
 * maps to a native chant target:
 *   tier 1 — a clean 1:1 native resource (e.g. `aws_s3_bucket` → `AWS::S3::Bucket`)
 *   tier 2 — maps, but with reshaping (multiple TF blocks → one native resource)
 *   tier 3 — a hard/partial map
 *   null   — no known native mapping (unsupported provider/type) → score 0
 *
 * This is a curated seed, not exhaustive. It covers the #197 worked examples and
 * the common tier-1 leaves the advisor is most useful on. It is deliberately
 * data so the eventual emit phase (#197) and lexicon coverage metadata can grow
 * it — the honest v1 scope is "score the leaves people actually carve first."
 */

export interface TierInfo {
  tier: 1 | 2 | 3;
  /** The native spec type a carve would target, for the report. */
  mapsTo: string;
}

/** TF resource type → native tier. Absent = unsupported (score 0). */
export const TIER_MAP: Record<string, TierInfo> = {
  // AWS tier-1 leaves
  aws_s3_bucket: { tier: 1, mapsTo: "AWS::S3::Bucket" },
  aws_cloudwatch_log_group: { tier: 1, mapsTo: "AWS::Logs::LogGroup" },
  aws_iam_policy: { tier: 1, mapsTo: "AWS::IAM::ManagedPolicy" },
  aws_iam_role: { tier: 1, mapsTo: "AWS::IAM::Role" },
  aws_sns_topic: { tier: 1, mapsTo: "AWS::SNS::Topic" },
  aws_sqs_queue: { tier: 1, mapsTo: "AWS::SQS::Queue" },
  aws_dynamodb_table: { tier: 1, mapsTo: "AWS::DynamoDB::Table" },
  aws_vpc: { tier: 1, mapsTo: "AWS::EC2::VPC" },
  aws_subnet: { tier: 1, mapsTo: "AWS::EC2::Subnet" },
  aws_security_group: { tier: 1, mapsTo: "AWS::EC2::SecurityGroup" },
  aws_route_table: { tier: 1, mapsTo: "AWS::EC2::RouteTable" },
  aws_internet_gateway: { tier: 1, mapsTo: "AWS::EC2::InternetGateway" },
  // AWS tier-2 (reshaped / composite-ish)
  aws_lambda_function: { tier: 2, mapsTo: "AWS::Lambda::Function" },
  aws_ecs_service: { tier: 2, mapsTo: "AWS::ECS::Service" },
  // Kubernetes — near-1:1 manifest
  kubernetes_manifest: { tier: 1, mapsTo: "k8s:manifest" },
};

/**
 * TF "sub-resource" types that inline into a parent resource rather than
 * standing alone (TF splits config the native spec keeps in one resource).
 * A sub-resource that shares its parent's name is folded into the parent's
 * carve set: it is not ranked on its own, and its edge to the parent does not
 * count as inbound boundary work — inlining it is free.
 *
 * Maps sub-resource TF type → parent TF type.
 */
export const FOLDS_INTO: Record<string, string> = {
  aws_s3_bucket_versioning: "aws_s3_bucket",
  aws_s3_bucket_acl: "aws_s3_bucket",
  aws_s3_bucket_policy: "aws_s3_bucket",
  aws_s3_bucket_public_access_block: "aws_s3_bucket",
  aws_s3_bucket_server_side_encryption_configuration: "aws_s3_bucket",
  aws_s3_bucket_lifecycle_configuration: "aws_s3_bucket",
};

export function resolveTier(tfType: string): TierInfo | null {
  return TIER_MAP[tfType] ?? null;
}
