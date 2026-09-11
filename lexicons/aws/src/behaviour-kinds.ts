/**
 * What this lexicon's entity types are worth to a behaviour engine (#2382).
 *
 * Contributed as rows through the plugin's `behaviourKinds` field; the
 * vocabulary, the resolution and the prediction are
 * `packages/core/src/behaviour-kinds.ts`. These rows were a section of one
 * cross-lexicon table in one lexicon until #2382 moved each substrate's
 * rows to the lexicon that owns the types — this file can say what
 * `AWS::EC2::Instance` means because it is the file that defines it.
 *
 * A table rather than a heuristic over type names: a heuristic would map
 * `AWS::EC2::VolumeAttachment` to storage and price a join table.
 */

import type { BehaviourKinds } from "@intentius/chant/behaviour-kinds";

/** Types an engine prices, with the declared property its size is read from. */
const MAPPED: BehaviourKinds["mapped"] = {

  "AWS::EC2::Instance": { kind: "compute", sizeProp: "InstanceType", sizeType: "string" },
  "AWS::EC2::Volume": { kind: "block-store", sizeProp: "Size", sizeType: "number", regionProp: "AvailabilityZone" },
  "AWS::Lambda::Function": { kind: "serverless", sizeProp: "MemorySize", sizeType: "number" },
  "AWS::RDS::DBInstance": { kind: "database", sizeProp: "DBInstanceClass", sizeType: "string" },
  "AWS::RDS::DBCluster": { kind: "database", sizeProp: "DBClusterInstanceClass", sizeType: "string" },
  "AWS::DynamoDB::Table": { kind: "database", sizeProp: "BillingMode", sizeType: "string" },
  "AWS::ElastiCache::CacheCluster": { kind: "cache", sizeProp: "CacheNodeType", sizeType: "string" },
  "AWS::SQS::Queue": { kind: "queue" },
  "AWS::SNS::Topic": { kind: "queue" },
  "AWS::S3::Bucket": { kind: "object-store" },
  "AWS::ElasticLoadBalancingV2::LoadBalancer": { kind: "load-balancer", sizeProp: "Type", sizeType: "string" },
  "AWS::CloudFront::Distribution": { kind: "cdn" },
  /** A flat hourly fee for the managed control plane. It does not move with the estate's traffic. */
  "AWS::EKS::Cluster": { kind: "control-plane" },
  /**
   * A set of EC2 instances, and what an EKS estate actually costs. No size:
   * `InstanceTypes` is a list, and this contract's `size` is one string.
   */
  "AWS::EKS::Nodegroup": { kind: "compute" },
  /** The running thing. Its task definition is the template and carries no rate. */
  "AWS::ECS::Service": { kind: "compute" },
};

/**
 * Types considered and declared unsendable, each with the reason it carries no
 * rate. Four of the five families core's contributor guidance names appear
 * here: a grant is not a resource, a boundary is not a node, a meter chant
 * cannot read is not a figure, and a template is not an instance.
 */
const UNMAPPED: BehaviourKinds["unmapped"] = {
  // ── Grants ───────────────────────────────────────────────────────
  "AWS::IAM::Role": "a role is a grant, not a resource traffic flows through: no rate, no capacity, no verdict under a lost zone",
  "AWS::IAM::Policy": "a policy document is a statement about permission; nothing about it saturates or accrues",
  "AWS::IAM::ManagedPolicy": "a policy document is a statement about permission; nothing about it saturates or accrues",
  "AWS::IAM::InstanceProfile": "a wrapper that hands a role to an instance; the instance carries the figures",
  "AWS::S3::BucketPolicy": "a bucket policy is a grant on the bucket beside it, and the bucket carries the figures",
  "AWS::SQS::QueuePolicy": "a queue policy is a grant on the queue beside it, and the queue carries the figures",
  "AWS::Lambda::Permission": "a grant letting one service invoke a function; the function carries the figures",
  // ── Boundaries, and the wiring that puts things inside them ──────
  "AWS::EC2::VPC": "a network boundary rather than a node: its contribution to a prediction is the zone membership that reaches the engine as containment coverage",
  "AWS::EC2::Subnet": "a network boundary rather than a node: its contribution to a prediction is the zone membership that reaches the engine as containment coverage",
  "AWS::EC2::SecurityGroup": "a filter on edges that already exist, not a thing at either end of one",
  "AWS::EC2::RouteTable": "routing, which decides where an edge goes and is not itself at either end of one",
  "AWS::EC2::Route": "routing, which decides where an edge goes and is not itself at either end of one",
  "AWS::EC2::SubnetRouteTableAssociation": "an association between two boundaries; nothing flows through it that does not already flow through them",
  "AWS::EC2::InternetGateway": "a boundary crossing rather than a resource: no rate of its own and no capacity to saturate",
  "AWS::EC2::VPCGatewayAttachment": "an attachment between two boundaries, and neither end is priced by it",
  "AWS::RDS::DBSubnetGroup": "the set of subnets a database may sit in; the database carries the figures",
  "AWS::ECS::Cluster": "a namespace for services rather than capacity of its own; the services and their nodes carry the figures",
  // ── Meters chant cannot read ─────────────────────────────────────
  "AWS::Logs::LogGroup": "priced by the volume ingested into it, which the declaration does not state and no engine can infer from a graph",
  "AWS::WAFv2::WebACL": "priced by the requests inspected through it, which the declaration does not state",
  "AWS::EC2::NatGateway": "priced as an hourly rate plus a per-gigabyte meter on everything that crosses it. The declaration states the first and nothing at all about the second, and no engine kind here models a half-known price — a figure covering the hourly half alone would read as the cost of the gateway and be wrong by whatever the traffic did",
  "AWS::EC2::EIP": "priced only while it is attached to nothing, which is a fact about the running account rather than about the declaration",
  "AWS::ECR::Repository": "priced by the gigabytes stored in it, which the declaration does not state",
  "AWS::KMS::Key": "priced per key per month plus a per-request meter the declaration does not state, and neither half is an hourly rate",
  "AWS::Route53::HostedZone": "priced per zone per month plus a per-query meter the declaration does not state",
  "AWS::SNS::Subscription": "priced by the notifications delivered through it; the topic is what the graph has an edge to",
  "AWS::Events::Rule": "priced by the events matched, which is a fact about traffic the declaration does not state",
  // ── Templates, not instances ─────────────────────────────────────
  "AWS::ECS::TaskDefinition": "a template a service runs copies of; the service carries the figures, and pricing both would count the estate twice",
  "AWS::Lambda::EventSourceMapping": "the wiring between a queue and a function, both of which are priced where they are declared",
  "AWS::ElasticLoadBalancingV2::TargetGroup": "a set of targets behind a load balancer; the load balancer carries the rate",
  "AWS::ElasticLoadBalancingV2::Listener": "a port on a load balancer; the load balancer carries the rate",
  "AWS::ElasticLoadBalancingV2::ListenerRule": "a routing rule on a listener, and a rule is not a thing at either end of an edge",
  // ── Not resources at all ─────────────────────────────────────────
  "AWS::CloudFormation::Parameter": "a template input, not a thing the account holds. It shapes what is created and is never created itself",
  "AWS::CloudFormation::Condition": "a template predicate deciding whether something is created; it is never created itself",
  // ── Meters on a managed agent runtime ────────────────────────────
  // Bedrock AgentCore is billed per invocation and per token consumed. Neither
  // is in a declaration, and an hourly rate for an agent that ran twice this
  // week would be a number with no relationship to the bill.
  "AWS::BedrockAgentCore::Runtime": "an agent runtime billed per invocation and per token, neither of which the declaration states; there is no hour of existence to price",
  "AWS::BedrockAgentCore::Gateway": "a front door to an agent runtime, billed by what passes through it rather than by existing",
  "AWS::BedrockAgentCore::GatewayTarget": "one target behind a gateway; the gateway and the runtime are where the meters are",
  "AWS::BedrockAgentCore::Memory": "agent memory billed by what is stored and retrieved, which the declaration does not state",
  "AWS::BedrockAgentCore::WorkloadIdentity": "an identity a runtime acts as; a grant, with no rate and no capacity",
};

/**
 * A CloudFormation **property** type — `AWS::S3::Bucket.VersioningConfiguration`
 * — recognised by the dot. These are nested blocks of the resource above them
 * that became entities of their own in the build; there are hundreds, they are
 * never separately priced, and enumerating them one row at a time would bury
 * this table's real decisions under boilerplate.
 */
function propertyType(type: string): string | undefined {
  return type.includes(".")
    ? "a CloudFormation property type: a nested block of the resource above it, which became an " +
        "entity of its own in the build. The resource carries the figures, and pricing the block as " +
        "well would count part of the estate twice"
    : undefined;
}

/** This lexicon's answer for its own types. */
export const awsBehaviourKinds: BehaviourKinds = {
  provider: "aws",
  prefixes: ["AWS::"],
  mapped: MAPPED,
  unmapped: UNMAPPED,
  unmappedWhen: propertyType,
};
