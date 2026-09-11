/**
 * What a terraform root's blocks are worth to a behaviour engine (#2382).
 *
 * Contributed as rows through the plugin's `behaviourKinds` field; the
 * vocabulary and the resolution are `packages/core/src/behaviour-kinds.ts`.
 *
 * These rows lived in one cross-lexicon table until #2382, which is why the
 * version before this one described terraform's block shape in prose: it could
 * not import it. This file can. Every `resource` block parses to one entity with
 * the same `entityType`, `Terraform::Resource` (`../hcl/parse.ts`), so the
 * type an engine would price is the segment before the first dot of
 * `props.address`, and the arguments a size is read from are under
 * `props.body` in terraform's own vocabulary — `instance_type`, not
 * `InstanceType`.
 *
 * ## One lexicon, every provider there is
 *
 * A terraform root can declare anything any provider offers, so unlike the aws
 * or k8s lexicons this one models part of what it declares and says so. An
 * `aws_` type reaches the tables below; every other prefix is a substrate
 * nothing here models, named by its provider, through `notModelledWhen`. An
 * `aws_` type with no row stays `unknown-type` — the one verdict that is a
 * defect rather than a decision, and the reason the two are separate hooks.
 *
 * The rows are the CloudFormation rows of the aws lexicon's table, spelled the
 * way the aws provider spells them. They exist because a choudoufu root is a
 * terraform root and the live path (#2360) predicts the account it holds;
 * without them every resource in such an estate was `provider-not-modelled`
 * and the declared-versus-live delta was a difference between two zeroes.
 */

import type { BehaviourKinds } from "@intentius/chant/behaviour-kinds";

/** The entity type every `resource` block arrives as. */
export const TERRAFORM_RESOURCE_TYPE = "Terraform::Resource";

/**
 * A terraform resource type: the provider's name, an underscore, and the rest.
 * Terraform's own naming rule, and the whole of what tells a type apart from
 * the identity a live row can carry in an address's place.
 */
const TERRAFORM_TYPE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*_[a-z0-9_]+$/;

/** Provider types an engine prices, with the argument its size is read from. */
const MAPPED: BehaviourKinds["mapped"] = {
  aws_instance: { kind: "compute", sizeProp: "body.instance_type", sizeType: "string" },
  aws_ebs_volume: { kind: "block-store", sizeProp: "body.size", sizeType: "number", regionProp: "body.availability_zone" },
  aws_lambda_function: { kind: "serverless", sizeProp: "body.memory_size", sizeType: "number" },
  aws_db_instance: { kind: "database", sizeProp: "body.instance_class", sizeType: "string" },
  /** The cluster carries the rate an engine prices; its instances (`aws_rds_cluster_instance`) carry the class. */
  aws_rds_cluster: { kind: "database" },
  aws_rds_cluster_instance: { kind: "database", sizeProp: "body.instance_class", sizeType: "string" },
  aws_dynamodb_table: { kind: "database", sizeProp: "body.billing_mode", sizeType: "string" },
  aws_elasticache_cluster: { kind: "cache", sizeProp: "body.node_type", sizeType: "string" },
  aws_sqs_queue: { kind: "queue" },
  aws_sns_topic: { kind: "queue" },
  aws_s3_bucket: { kind: "object-store" },
  aws_lb: { kind: "load-balancer", sizeProp: "body.load_balancer_type", sizeType: "string" },
  /** The provider's older name for `aws_lb`; the same resource. */
  aws_alb: { kind: "load-balancer", sizeProp: "body.load_balancer_type", sizeType: "string" },
  aws_cloudfront_distribution: { kind: "cdn" },
  aws_eks_cluster: { kind: "control-plane" },
  /** No size: `instance_types` is a list, and this contract's `size` is one string. */
  aws_eks_node_group: { kind: "compute" },
  aws_ecs_service: { kind: "compute" },
};

/** Provider types that are real and carry no rate, with the reason for each. */
const UNMAPPED: BehaviourKinds["unmapped"] = {
  // ── Grants ───────────────────────────────────────────────────────
  aws_iam_role: "a role is a grant, not a resource traffic flows through: no rate, no capacity, no verdict under a lost zone",
  aws_iam_policy: "a policy document is a statement about permission; nothing about it saturates or accrues",
  aws_iam_role_policy: "a policy document attached inline to a role; a statement about permission",
  aws_iam_role_policy_attachment: "the attachment of a grant to a role; neither end is priced by it",
  aws_iam_instance_profile: "a wrapper that hands a role to an instance; the instance carries the figures",
  aws_s3_bucket_policy: "a bucket policy is a grant on the bucket beside it, and the bucket carries the figures",
  aws_sqs_queue_policy: "a queue policy is a grant on the queue beside it, and the queue carries the figures",
  aws_lambda_permission: "a grant letting one service invoke a function; the function carries the figures",

  // ── Boundaries, and the wiring that puts things inside them ──────
  aws_vpc: "a network boundary rather than a node: its contribution to a prediction is the zone membership that reaches the engine as containment coverage",
  aws_subnet: "a network boundary rather than a node: its contribution to a prediction is the zone membership that reaches the engine as containment coverage",
  aws_security_group: "a filter on edges that already exist, not a thing at either end of one",
  aws_security_group_rule: "one rule of a filter on edges that already exist; the rule is not a thing at either end of one",
  aws_vpc_security_group_ingress_rule: "one rule of a filter on edges that already exist; the rule is not a thing at either end of one",
  aws_vpc_security_group_egress_rule: "one rule of a filter on edges that already exist; the rule is not a thing at either end of one",
  aws_route_table: "routing, which decides where an edge goes and is not itself at either end of one",
  aws_route: "routing, which decides where an edge goes and is not itself at either end of one",
  aws_route_table_association: "an association between two boundaries; nothing flows through it that does not already flow through them",
  aws_internet_gateway: "a boundary crossing rather than a resource: no rate of its own and no capacity to saturate",
  aws_db_subnet_group: "the set of subnets a database may sit in; the database carries the figures",
  aws_elasticache_subnet_group: "the set of subnets a cache may sit in; the cache carries the figures",
  aws_ecs_cluster: "a namespace for services rather than capacity of its own; the services and their nodes carry the figures",
  aws_network_interface: "where an instance's networking lives; the instance carries the figures",

  // ── Meters chant cannot read ─────────────────────────────────────
  aws_cloudwatch_log_group: "priced by the volume ingested into it, which the declaration does not state and no engine can infer from a graph",
  aws_wafv2_web_acl: "priced by the requests inspected through it, which the declaration does not state",
  aws_nat_gateway: "priced as an hourly rate plus a per-gigabyte meter on everything that crosses it. The declaration states the first and nothing at all about the second, and no engine kind here models a half-known price",
  aws_eip: "priced only while it is attached to nothing, which is a fact about the running account rather than about the declaration",
  aws_ecr_repository: "priced by the gigabytes stored in it, which the declaration does not state",
  aws_kms_key: "priced per key per month plus a per-request meter the declaration does not state, and neither half is an hourly rate",
  aws_route53_zone: "priced per zone per month plus a per-query meter the declaration does not state",
  aws_route53_record: "a record in a zone priced per query; the zone is where the meter is, and the declaration does not state it",
  aws_sns_topic_subscription: "priced by the notifications delivered through it; the topic is what the graph has an edge to",
  aws_cloudwatch_event_rule: "priced by the events matched, which is a fact about traffic the declaration does not state",

  // ── Templates, not instances ─────────────────────────────────────
  aws_ecs_task_definition: "a template a service runs copies of; the service carries the figures, and pricing both would count the estate twice",
  aws_lambda_event_source_mapping: "the wiring between a queue and a function, both of which are priced where they are declared",
  aws_lb_target_group: "a set of targets behind a load balancer; the load balancer carries the rate",
  aws_lb_target_group_attachment: "one target's membership of a target group; the target and the load balancer carry the figures",
  aws_lb_listener: "a port on a load balancer; the load balancer carries the rate",
  aws_lb_listener_rule: "a routing rule on a listener, and a rule is not a thing at either end of an edge",
  aws_launch_template: "a template instances are launched from; the instances carry the figures",

  // ── Settings on the resource beside them ─────────────────────────
  aws_s3_bucket_versioning: "a setting on the bucket beside it; the bucket carries the figures",
  aws_s3_bucket_public_access_block: "a setting on the bucket beside it; the bucket carries the figures",
  aws_s3_bucket_server_side_encryption_configuration: "a setting on the bucket beside it; the bucket carries the figures",
  aws_s3_bucket_lifecycle_configuration: "a setting on the bucket beside it; the bucket carries the figures",
  aws_s3_bucket_ownership_controls: "a setting on the bucket beside it; the bucket carries the figures",
  aws_s3_bucket_acl: "a grant on the bucket beside it; the bucket carries the figures",
};

/** The root's own blocks, which are not resources in any account. */
const BLOCKS: Readonly<Record<string, string>> = {
  // ── Terraform blocks that are not resources ──────────────────────
  // A `resource` block is not here: it is `Terraform::Resource` whatever its
  // provider type, and `coverageFor` dispatches it on the provider type in
  // its address to the
  // terraform half of the table (`./mapping-terraform.ts`, #2360).
  "Terraform::Terraform": "the root's settings block, which names providers and a backend and holds nothing in any account",
  "Terraform::Provider": "a provider configuration: how terraform reaches an account, not a thing the account holds",
  "Terraform::Variable": "a root module input; it shapes what is created and is never created itself",
  "Terraform::Output": "a value the root publishes after an apply, not a thing the account holds",
  "Terraform::Locals": "named expressions a root reuses; they exist only in the evaluation",
  "Terraform::Module": "a call to a child module; the blocks the call expands to are entities of their own and carry the figures",
  "Terraform::Data": "a read of something that exists outside this root; whatever it reads is priced where it is declared",
  "Terraform::Live": "choudoufu's estate declaration, which names the ownership marker every resource of the root carries and holds nothing itself",
};

const UNMODELLED_TERRAFORM_PROVIDERS: ReadonlyArray<{ prefix: string; substrate: string }> = [
  { prefix: "google_", substrate: "Google Cloud (the google terraform provider)" },
  { prefix: "google-beta_", substrate: "Google Cloud (the google-beta terraform provider)" },
  { prefix: "azurerm_", substrate: "Azure (the azurerm terraform provider)" },
  { prefix: "azuread_", substrate: "Azure (the azuread terraform provider)" },
  {
    prefix: "kubernetes_",
    substrate:
      "the kubernetes terraform provider. The Kubernetes rows are the k8s lexicon's own types, and a manifest applied through terraform is a different entity with a different shape",
  },
  { prefix: "helm_", substrate: "Helm through terraform (a chart is a package, and what it installs is Kubernetes)" },
  { prefix: "null_", substrate: "the null provider, a utility with nothing in any account" },
  { prefix: "random_", substrate: "the random provider, a utility with nothing in any account" },
  { prefix: "local_", substrate: "the local provider, which writes files on the machine running terraform" },
  { prefix: "tls_", substrate: "the tls provider, a utility with nothing in any account" },
  { prefix: "time_", substrate: "the time provider, a utility with nothing in any account" },
  { prefix: "archive_", substrate: "the archive provider, a utility with nothing in any account" },
  { prefix: "external_", substrate: "the external provider, a program run on the machine running terraform" },
  { prefix: "terraform_", substrate: "terraform's own built-in provider, which holds nothing in any account" },
];

/**
 * The provider type an engine would price, off the block's address — or the
 * `resourceType` a live row states, which `observeAmbient` already uses.
 * `undefined` is "nothing to look up", the same no-opinion an unseen type
 * gets, which is why a live row whose ARN stands in for an address is not
 * sliced at a dot and read as a type.
 */
function resolveType(props: Record<string, unknown> | undefined): string | undefined {
  const stated = props?.resourceType;
  if (typeof stated === "string" && stated.length > 0) return stated;
  const address = props?.address;
  if (typeof address !== "string") return undefined;
  const dot = address.indexOf(".");
  if (dot <= 0) return undefined;
  const type = address.slice(0, dot);
  return TERRAFORM_TYPE.test(type) ? type : undefined;
}

/** This lexicon's answer for its own blocks. */
export const terraformBehaviourKinds: BehaviourKinds = {
  provider: "aws",
  prefixes: ["Terraform::"],
  resolveType: (entityType, props) =>
    entityType === TERRAFORM_RESOURCE_TYPE ? resolveType(props) : entityType,
  mapped: MAPPED,
  unmapped: { ...UNMAPPED, ...BLOCKS },
  notModelledWhen: (type) => {
    // A root block keyed by its own entity type is this lexicon's, not
    // another provider's, and an `aws_` type with no row is a missing row.
    if (type.startsWith("aws_") || type.startsWith("Terraform::")) return undefined;
    for (const { prefix, substrate } of UNMODELLED_TERRAFORM_PROVIDERS) {
      if (type.startsWith(prefix)) return substrate;
    }
    const provider = type.includes("_") ? type.slice(0, type.indexOf("_")) : type;
    return `the ${provider} terraform provider, which nothing here models`;
  },
};
