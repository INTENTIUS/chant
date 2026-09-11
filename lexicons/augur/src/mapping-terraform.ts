/**
 * The coverage table's terraform half (#2360).
 *
 * The terraform lexicon parses a root module into one entity per HCL block,
 * and every `resource` block arrives with the same `entityType`,
 * `Terraform::Resource` (`lexicons/terraform/src/hcl/parse.ts`). The provider
 * type an engine would price — `aws_instance`, `aws_s3_bucket` — is
 * the segment before the first dot of `props.address`, and the arguments a
 * size is read from are under
 * `props.body`, in terraform's own vocabulary: `instance_type`, not
 * `InstanceType`.
 *
 * So one `entityType` row cannot say anything useful about a terraform block,
 * and `./mapping.ts`'s `coverageFor` dispatches here on the provider type
 * {@link terraformResourceType} reads off the address instead.
 * The rows below are the CloudFormation rows of the main table, spelled the
 * way the aws provider spells them, and they exist for one reason: a
 * choudoufu root is a terraform root, and the live path (#2360) predicts the
 * account it holds. Without these rows every resource in such an estate was
 * `provider-not-modelled`, and the declared-versus-live delta the epic asks
 * for was a difference between two zeroes.
 *
 * ## What is a terraform provider and what is a substrate
 *
 * augur models aws and kubernetes. A terraform block's substrate is named by
 * its type's prefix: `aws_` is aws, and has rows here; `google_` is Google
 * Cloud and `azurerm_` is Azure, which augur does not model, and neither
 * does it model the `kubernetes_` provider — augur's Kubernetes rows are the
 * k8s lexicon's own types, and a manifest applied through terraform's
 * provider is a different entity with a different shape. A `null_`,
 * `random_`, `local_` or `tls_` block is a utility provider with nothing in
 * any account. All of those are stated boundaries, reported as
 * `provider-not-modelled`; an `aws_` type with no row is `unknown-type`, the
 * one verdict that is a defect, exactly as it is for a CloudFormation type.
 */

import type { EngineKindMapping } from "./mapping";

/** The terraform lexicon's `resource` block. See {@link terraformResourceType} for where its provider type is. */
export const TERRAFORM_RESOURCE_TYPE = "Terraform::Resource";

/**
 * Mapped terraform resource types, keyed by provider type. `sizeProp` paths
 * start at `body.` because that is where the block's arguments are on the
 * entity; the request reads them with the same dotted lookup it uses for a
 * Kubernetes `spec.type`.
 */
export const ENGINE_KINDS_BY_TERRAFORM_TYPE: Readonly<Record<string, EngineKindMapping>> = {
  aws_instance: { kind: "compute", provider: "aws", sizeProp: "body.instance_type", sizeType: "string" },
  aws_ebs_volume: { kind: "block-store", provider: "aws", sizeProp: "body.size", sizeType: "number", regionProp: "body.availability_zone" },
  aws_lambda_function: { kind: "serverless", provider: "aws", sizeProp: "body.memory_size", sizeType: "number" },
  aws_db_instance: { kind: "database", provider: "aws", sizeProp: "body.instance_class", sizeType: "string" },
  /** The cluster carries the rate an engine prices; its instances (`aws_rds_cluster_instance`) carry the class. */
  aws_rds_cluster: { kind: "database", provider: "aws" },
  aws_rds_cluster_instance: { kind: "database", provider: "aws", sizeProp: "body.instance_class", sizeType: "string" },
  aws_dynamodb_table: { kind: "database", provider: "aws", sizeProp: "body.billing_mode", sizeType: "string" },
  aws_elasticache_cluster: { kind: "cache", provider: "aws", sizeProp: "body.node_type", sizeType: "string" },
  aws_sqs_queue: { kind: "queue", provider: "aws" },
  aws_sns_topic: { kind: "queue", provider: "aws" },
  aws_s3_bucket: { kind: "object-store", provider: "aws" },
  aws_lb: { kind: "load-balancer", provider: "aws", sizeProp: "body.load_balancer_type", sizeType: "string" },
  /** The provider's older name for `aws_lb`; the same resource. */
  aws_alb: { kind: "load-balancer", provider: "aws", sizeProp: "body.load_balancer_type", sizeType: "string" },
  aws_cloudfront_distribution: { kind: "cdn", provider: "aws" },
  aws_eks_cluster: { kind: "control-plane", provider: "aws" },
  /** No size: `instance_types` is a list, and this contract's `size` is one string. */
  aws_eks_node_group: { kind: "compute", provider: "aws" },
  aws_ecs_service: { kind: "compute", provider: "aws" },
};

/**
 * Terraform resource types augur will not send, with the reason. The families
 * are the main table's: a grant is not a resource, a boundary is not a node, a
 * meter chant cannot read, a template is not an instance — plus one the aws
 * provider adds on its own: a **setting on a resource beside it**. The provider
 * splits a bucket's versioning, encryption and public-access configuration
 * into resources of their own, and each is a statement about the bucket, which
 * carries the figures.
 */
export const DECLARED_UNMAPPED_TERRAFORM: Readonly<Record<string, string>> = {
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

/**
 * Terraform provider prefixes augur does **not** model, and the sentence each
 * one gets. Matched by prefix because the decision is per provider: modelling
 * gcp means a table of gcp rows and a price model per gcp kind, not a row.
 */
const UNMODELLED_TERRAFORM_PROVIDERS: ReadonlyArray<{ prefix: string; substrate: string }> = [
  { prefix: "google_", substrate: "Google Cloud (the google terraform provider)" },
  { prefix: "google-beta_", substrate: "Google Cloud (the google-beta terraform provider)" },
  { prefix: "azurerm_", substrate: "Azure (the azurerm terraform provider)" },
  { prefix: "azuread_", substrate: "Azure (the azuread terraform provider)" },
  {
    prefix: "kubernetes_",
    substrate:
      "the kubernetes terraform provider. augur's Kubernetes rows are the k8s lexicon's own types, and a manifest applied through terraform is a different entity with a different shape",
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

/** Why a terraform resource type produced no prediction. The same four shapes `./mapping.ts` reports. */
export type TerraformCoverageVerdict =
  | { status: "mapped"; mapping: EngineKindMapping }
  | { status: "declared-unmapped"; reason: string }
  | { status: "provider-not-modelled"; substrate: string }
  | { status: "unknown-type"; tables: string };

/**
 * Look one terraform provider type up. Total: an `aws_` type is mapped,
 * declared unmapped, or `unknown-type`; every other prefix is a substrate
 * augur does not model, named by its provider.
 *
 * `hasOwnProperty` on both tables, for the reason `./mapping.ts` gives: a
 * bare object literal answers `"constructor"` with a function.
 */
export function terraformCoverageFor(type: string): TerraformCoverageVerdict {
  if (Object.prototype.hasOwnProperty.call(ENGINE_KINDS_BY_TERRAFORM_TYPE, type)) {
    return { status: "mapped", mapping: ENGINE_KINDS_BY_TERRAFORM_TYPE[type] };
  }
  if (Object.prototype.hasOwnProperty.call(DECLARED_UNMAPPED_TERRAFORM, type)) {
    return { status: "declared-unmapped", reason: DECLARED_UNMAPPED_TERRAFORM[type] };
  }
  if (type.startsWith("aws_")) {
    return { status: "unknown-type", tables: "ENGINE_KINDS_BY_TERRAFORM_TYPE or DECLARED_UNMAPPED_TERRAFORM in lexicons/augur/src/mapping-terraform.ts" };
  }
  for (const { prefix, substrate } of UNMODELLED_TERRAFORM_PROVIDERS) {
    if (type.startsWith(prefix)) return { status: "provider-not-modelled", substrate };
  }
  const provider = type.includes("_") ? type.slice(0, type.indexOf("_")) : type;
  return {
    status: "provider-not-modelled",
    substrate: `the ${provider} terraform provider, which augur does not model`,
  };
}

/**
 * A terraform resource type: the provider's name, an underscore, and the rest.
 * Terraform's own naming rule, and the whole of what tells a type apart from
 * the identity a live row can carry in an address's place.
 */
const TERRAFORM_TYPE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*_[a-z0-9_]+$/;

/**
 * The provider type a `Terraform::Resource` is: `aws_subnet`.
 *
 * Two producers, checked in the order of how directly each one states it.
 *
 * `props.resourceType` is what a **live** row carries. `live-ls` reports a
 * resource's type as a field of its own, and both the live paths that surface
 * an undeclared resource put it there under that name
 * (`lexicons/terraform/src/describe-resources.ts`'s `observeAmbient`, and the
 * behaviour request builder beside it). A resource nothing declares has no
 * terraform address to read a type out of, so this is the only place its type
 * is stated at all.
 *
 * Otherwise the **address**. A declared block carries no `type` field:
 * `resource "aws_subnet" "app"` becomes
 * `{ address: "aws_subnet.app", body: {…}, file, line, root }`
 * (`lexicons/terraform/src/hcl/parse.ts`, which composes the address as
 * `${type}.${name}`), and that address stays unqualified even for a block
 * inside a descended child module — the calling chain is on `props.callers`
 * and the `module.<name>` segments are in the entity's key, never in this
 * string. So the segment before the first dot is the type, with no chain to
 * strip.
 *
 * The segment is only taken when it is shaped like a terraform type, which
 * terraform requires to be the provider's name, an underscore, and the rest:
 * {@link TERRAFORM_TYPE}. That is what rules out the shape a live row falls
 * back to when the listing decoded no address at all and its identity stands
 * in for one — `arn:aws:s3:::my.bucket.name` has a first dot, and slicing at
 * it would hand the coverage table `arn:aws:s3:::my` as a provider type.
 *
 * There is deliberately no `props.type`: nothing in the build or in either
 * live read writes one, and accepting it would be a lookup that works in a
 * test that types it by hand and returns `unknown-type` against the entities a
 * real root produces — which is how this function was wrong when it was first
 * written (#2360).
 */
export function terraformResourceType(props: Record<string, unknown> | undefined): string | undefined {
  const stated = props?.resourceType;
  if (typeof stated === "string" && stated.length > 0) return stated;
  const address = props?.address;
  if (typeof address !== "string") return undefined;
  const dot = address.indexOf(".");
  if (dot <= 0) return undefined;
  const type = address.slice(0, dot);
  return TERRAFORM_TYPE.test(type) ? type : undefined;
}
