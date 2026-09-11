/**
 * How the aws provider's resources reference each other, as a `ReferenceCatalog`
 * over terraform's own argument names (#2360).
 *
 * `packages/core/src/graph-refs.ts`'s `reconstructEdges` turns a bag of nodes
 * into a graph by reading identifier values out of each node's attributes and
 * matching them against every other node's identity. The aws lexicon's
 * catalog does that over the SDK's shape (`VpcId`, `SecurityGroups[].GroupId`);
 * this one does it over a terraform block's shape (`vpc_id`,
 * `vpc_security_group_ids[]`), because that is the shape a block's body has
 * after `../hcl/parse.ts` and the shape `./request.ts` hands the resolver on
 * both the declared and the live side.
 *
 * ## Keyed by provider type, not by chant entity type
 *
 * Every terraform `resource` block is `Terraform::Resource` to chant. A rule
 * keyed on that would apply to a VPC and an instance alike, so the nodes
 * `./request.ts` builds for the resolver carry the **provider type** as their
 * `kind` — `aws_subnet` — and the rules here are keyed the same way. That is
 * also why this catalog is not declared on the plugin as `referenceCatalog`:
 * `chant graph --live` builds its nodes with `kind: "Terraform::Resource"`
 * and attributes that carry no arguments at all, so declaring it there would
 * be a catalog that matched nothing and looked like coverage.
 *
 * ## Two relations, and why the split matters to an engine
 *
 * A `containment` rule (subnet ∈ VPC, instance ∈ subnet) becomes a boundary
 * pair and a traversable containment edge; a `reference` rule becomes an
 * ordinary edge. `PredictBehaviourOptions.edges` carries the second and
 * `edgeCoverage.containmentEdges` the first, and the contract keeps them
 * apart for a reason that is the whole of #2360's first review comment: a
 * "one zone lost" verdict is computed over zone membership, and membership is
 * not a reference. Both sides of the declared-versus-live delta run these
 * same rules, so neither side is structurally short of containment the other
 * has.
 *
 * ## Multi-kind arguments carry no `targetKind`
 *
 * `reconstructEdges` records a value under a rule with a `targetKind` as
 * dangling when the value resolves to a node of another kind. An argument
 * that legitimately points at more than one kind — a target-group attachment's
 * `target_id` is an instance or a function — would therefore report every
 * match of the other kind as a reference leaving the estate. Those rules name
 * no `targetKind` and take whatever the identifier resolves to, the same
 * choice the aws catalog makes for its CloudFormation template paths.
 *
 * ## What "no rule" means
 *
 * A kind with no rule here produces no edges and, on its own, no complaint —
 * the quiet gap `edgeCoverage.unresolvedKinds` exists to name. But "no rule"
 * has two causes that should not read alike: nobody has written one, or the
 * kind holds no identifier-bearing argument to write one about. A VPC
 * references nothing; an SQS queue names its dead-letter queue inside a JSON
 * document this catalog does not read. {@link REFERENCES_NOTHING} is the list
 * of kinds in the first position, checked rather than assumed, so that an
 * estate with a VPC in it is not `partial` forever and an estate with a queue
 * in it is not `complete` by omission.
 */

import type { ReferenceCatalog } from "@intentius/chant/graph-refs";

/**
 * Provider types this catalog has looked at and found to hold no argument
 * that identifies another resource. A node of one of these kinds is not an
 * unresolved kind: nothing was looked for because there is nothing to find.
 *
 * Deliberately short. A kind is added here when every identifier-bearing
 * argument it has is also a rule below, or when it has none — not when its
 * references happen to be inconvenient to read.
 */
export const REFERENCES_NOTHING: ReadonlySet<string> = new Set([
  "aws_vpc",
  "aws_s3_bucket",
  "aws_ecs_cluster",
  "aws_ecr_repository",
  "aws_route53_zone",
]);

/** The catalog. Rules are grouped by the relation they produce. */
export const TERRAFORM_REFERENCE_CATALOG: ReferenceCatalog = {
  // Every node is indexed by its own id and physical id (`reconstructEdges`
  // does that itself), and a block's body never carries a second identifier
  // for the block, so there are no identity rules to declare.
  identities: [],
  refs: [
    // ── containment (→ boundary pairs, and containment edges) ──
    { from: "aws_subnet", path: "vpc_id", targetKind: "aws_vpc", relation: "containment", label: "in VPC" },
    { from: "aws_security_group", path: "vpc_id", targetKind: "aws_vpc", relation: "containment", label: "in VPC" },
    { from: "aws_route_table", path: "vpc_id", targetKind: "aws_vpc", relation: "containment", label: "in VPC" },
    { from: "aws_internet_gateway", path: "vpc_id", targetKind: "aws_vpc", relation: "containment", label: "in VPC" },
    { from: "aws_lb_target_group", path: "vpc_id", targetKind: "aws_vpc", relation: "containment", label: "in VPC" },
    { from: "aws_vpc_endpoint", path: "vpc_id", targetKind: "aws_vpc", relation: "containment", label: "in VPC" },
    // An instance's subnet is the hop a topology fold takes first, so it is
    // traversable as an ordinary edge too — the same `viaAttr` opt-in the aws
    // catalog gives `AWS::EC2::Instance.SubnetId`.
    { from: "aws_instance", path: "subnet_id", targetKind: "aws_subnet", relation: "containment", label: "in subnet", viaAttr: "subnet_id" },
    { from: "aws_nat_gateway", path: "subnet_id", targetKind: "aws_subnet", relation: "containment", label: "in subnet" },
    { from: "aws_network_interface", path: "subnet_id", targetKind: "aws_subnet", relation: "containment", label: "in subnet" },
    { from: "aws_lb", path: "subnets[]", targetKind: "aws_subnet", relation: "containment", label: "in subnet" },
    { from: "aws_alb", path: "subnets[]", targetKind: "aws_subnet", relation: "containment", label: "in subnet" },
    { from: "aws_lambda_function", path: "vpc_config[].subnet_ids[]", targetKind: "aws_subnet", relation: "containment", label: "in subnet" },
    { from: "aws_db_subnet_group", path: "subnet_ids[]", targetKind: "aws_subnet", relation: "containment", label: "in subnet" },
    { from: "aws_elasticache_subnet_group", path: "subnet_ids[]", targetKind: "aws_subnet", relation: "containment", label: "in subnet" },
    { from: "aws_db_instance", path: "db_subnet_group_name", targetKind: "aws_db_subnet_group", relation: "containment", label: "in subnet group" },
    { from: "aws_rds_cluster", path: "db_subnet_group_name", targetKind: "aws_db_subnet_group", relation: "containment", label: "in subnet group" },
    { from: "aws_elasticache_cluster", path: "subnet_group_name", targetKind: "aws_elasticache_subnet_group", relation: "containment", label: "in subnet group" },
    { from: "aws_ecs_service", path: "network_configuration[].subnets[]", targetKind: "aws_subnet", relation: "containment", label: "in subnet" },
    { from: "aws_eks_cluster", path: "vpc_config[].subnet_ids[]", targetKind: "aws_subnet", relation: "containment", label: "in subnet" },
    { from: "aws_eks_node_group", path: "subnet_ids[]", targetKind: "aws_subnet", relation: "containment", label: "in subnet" },

    // ── references (→ edges) ──
    { from: "aws_security_group_rule", path: "security_group_id", targetKind: "aws_security_group", relation: "reference", label: "rule on", viaAttr: "security_group_id" },
    { from: "aws_security_group_rule", path: "source_security_group_id", targetKind: "aws_security_group", relation: "reference", label: "allows" },
    { from: "aws_vpc_security_group_ingress_rule", path: "security_group_id", targetKind: "aws_security_group", relation: "reference", label: "rule on", viaAttr: "security_group_id" },
    { from: "aws_vpc_security_group_ingress_rule", path: "referenced_security_group_id", targetKind: "aws_security_group", relation: "reference", label: "allows" },
    { from: "aws_vpc_security_group_egress_rule", path: "security_group_id", targetKind: "aws_security_group", relation: "reference", label: "rule on", viaAttr: "security_group_id" },
    { from: "aws_vpc_security_group_egress_rule", path: "referenced_security_group_id", targetKind: "aws_security_group", relation: "reference", label: "allows" },
    { from: "aws_instance", path: "vpc_security_group_ids[]", targetKind: "aws_security_group", relation: "reference", label: "sg", viaAttr: "vpc_security_group_ids" },
    { from: "aws_instance", path: "security_groups[]", targetKind: "aws_security_group", relation: "reference", label: "sg", viaAttr: "security_groups" },
    { from: "aws_instance", path: "iam_instance_profile", targetKind: "aws_iam_instance_profile", relation: "reference", label: "as" },
    { from: "aws_network_interface", path: "security_groups[]", targetKind: "aws_security_group", relation: "reference", label: "sg" },
    { from: "aws_lambda_function", path: "vpc_config[].security_group_ids[]", targetKind: "aws_security_group", relation: "reference", label: "sg" },
    { from: "aws_lambda_function", path: "role", targetKind: "aws_iam_role", relation: "reference", label: "as" },
    { from: "aws_db_instance", path: "vpc_security_group_ids[]", targetKind: "aws_security_group", relation: "reference", label: "sg" },
    { from: "aws_rds_cluster", path: "vpc_security_group_ids[]", targetKind: "aws_security_group", relation: "reference", label: "sg" },
    { from: "aws_rds_cluster_instance", path: "cluster_identifier", targetKind: "aws_rds_cluster", relation: "reference", label: "in cluster" },
    { from: "aws_elasticache_cluster", path: "security_group_ids[]", targetKind: "aws_security_group", relation: "reference", label: "sg" },
    { from: "aws_lb", path: "security_groups[]", targetKind: "aws_security_group", relation: "reference", label: "sg" },
    { from: "aws_alb", path: "security_groups[]", targetKind: "aws_security_group", relation: "reference", label: "sg" },
    { from: "aws_lb_listener", path: "load_balancer_arn", targetKind: "aws_lb", relation: "reference", label: "on" },
    { from: "aws_lb_listener", path: "default_action[].target_group_arn", targetKind: "aws_lb_target_group", relation: "reference", label: "forwards to" },
    { from: "aws_lb_target_group_attachment", path: "target_group_arn", targetKind: "aws_lb_target_group", relation: "reference", label: "in group" },
    // An instance, a function or an IP; no `targetKind` (see the module doc).
    { from: "aws_lb_target_group_attachment", path: "target_id", relation: "reference", label: "targets" },
    { from: "aws_route", path: "route_table_id", targetKind: "aws_route_table", relation: "reference", label: "in table", viaAttr: "route_table_id" },
    { from: "aws_route", path: "gateway_id", targetKind: "aws_internet_gateway", relation: "reference", label: "via", viaAttr: "gateway_id" },
    { from: "aws_route", path: "nat_gateway_id", targetKind: "aws_nat_gateway", relation: "reference", label: "via" },
    { from: "aws_route_table_association", path: "subnet_id", targetKind: "aws_subnet", relation: "reference", label: "associates", viaAttr: "subnet_id" },
    { from: "aws_route_table_association", path: "route_table_id", targetKind: "aws_route_table", relation: "reference", label: "to table", viaAttr: "route_table_id" },
    { from: "aws_nat_gateway", path: "allocation_id", targetKind: "aws_eip", relation: "reference", label: "uses" },
    { from: "aws_eip", path: "instance", targetKind: "aws_instance", relation: "reference", label: "attached to" },
    { from: "aws_eip", path: "network_interface", targetKind: "aws_network_interface", relation: "reference", label: "attached to" },
    { from: "aws_ecs_service", path: "cluster", targetKind: "aws_ecs_cluster", relation: "reference", label: "in cluster" },
    { from: "aws_ecs_service", path: "task_definition", targetKind: "aws_ecs_task_definition", relation: "reference", label: "runs" },
    { from: "aws_ecs_service", path: "load_balancer[].target_group_arn", targetKind: "aws_lb_target_group", relation: "reference", label: "registered in" },
    { from: "aws_ecs_service", path: "network_configuration[].security_groups[]", targetKind: "aws_security_group", relation: "reference", label: "sg" },
    { from: "aws_ecs_task_definition", path: "execution_role_arn", targetKind: "aws_iam_role", relation: "reference", label: "as" },
    { from: "aws_ecs_task_definition", path: "task_role_arn", targetKind: "aws_iam_role", relation: "reference", label: "as" },
    { from: "aws_eks_node_group", path: "cluster_name", targetKind: "aws_eks_cluster", relation: "reference", label: "in cluster" },
    { from: "aws_eks_cluster", path: "role_arn", targetKind: "aws_iam_role", relation: "reference", label: "as" },
    { from: "aws_s3_bucket_policy", path: "bucket", targetKind: "aws_s3_bucket", relation: "reference", label: "grant on" },
    { from: "aws_s3_bucket_versioning", path: "bucket", targetKind: "aws_s3_bucket", relation: "reference", label: "setting on" },
    { from: "aws_s3_bucket_public_access_block", path: "bucket", targetKind: "aws_s3_bucket", relation: "reference", label: "setting on" },
    { from: "aws_s3_bucket_server_side_encryption_configuration", path: "bucket", targetKind: "aws_s3_bucket", relation: "reference", label: "setting on" },
    { from: "aws_s3_bucket_lifecycle_configuration", path: "bucket", targetKind: "aws_s3_bucket", relation: "reference", label: "setting on" },
    { from: "aws_s3_bucket_ownership_controls", path: "bucket", targetKind: "aws_s3_bucket", relation: "reference", label: "setting on" },
    { from: "aws_s3_bucket_acl", path: "bucket", targetKind: "aws_s3_bucket", relation: "reference", label: "grant on" },
    { from: "aws_sqs_queue_policy", path: "queue_url", targetKind: "aws_sqs_queue", relation: "reference", label: "grant on" },
    { from: "aws_lambda_event_source_mapping", path: "event_source_arn", relation: "reference", label: "drains" },
    { from: "aws_lambda_event_source_mapping", path: "function_name", targetKind: "aws_lambda_function", relation: "reference", label: "invokes" },
    { from: "aws_lambda_permission", path: "function_name", targetKind: "aws_lambda_function", relation: "reference", label: "grant on" },
    { from: "aws_sns_topic_subscription", path: "topic_arn", targetKind: "aws_sns_topic", relation: "reference", label: "on" },
    { from: "aws_cloudwatch_log_group", path: "kms_key_id", targetKind: "aws_kms_key", relation: "reference", label: "encrypted with" },
    { from: "aws_sns_topic", path: "kms_master_key_id", targetKind: "aws_kms_key", relation: "reference", label: "encrypted with" },
    { from: "aws_dynamodb_table", path: "server_side_encryption[].kms_key_arn", targetKind: "aws_kms_key", relation: "reference", label: "encrypted with" },
    { from: "aws_iam_role_policy_attachment", path: "role", targetKind: "aws_iam_role", relation: "reference", label: "on" },
    { from: "aws_iam_role_policy_attachment", path: "policy_arn", targetKind: "aws_iam_policy", relation: "reference", label: "attaches" },
    { from: "aws_iam_role_policy", path: "role", targetKind: "aws_iam_role", relation: "reference", label: "on" },
    { from: "aws_iam_instance_profile", path: "role", targetKind: "aws_iam_role", relation: "reference", label: "holds" },
    { from: "aws_route53_record", path: "zone_id", targetKind: "aws_route53_zone", relation: "reference", label: "in zone" },
    // A bucket's regional domain name or a load balancer's DNS name; no `targetKind`.
    { from: "aws_cloudfront_distribution", path: "origin[].domain_name", relation: "reference", label: "origin" },
  ],
};

/** Every provider type the catalog has at least one rule from. */
export const CATALOGUED_KINDS: ReadonlySet<string> = new Set(TERRAFORM_REFERENCE_CATALOG.refs.map((r) => r.from));

/**
 * True when nothing would be looked for on a node of this kind: no rule is
 * written for it, and it is not one of the kinds known to reference nothing.
 */
export function isUnresolvedKind(kind: string): boolean {
  return !CATALOGUED_KINDS.has(kind) && !REFERENCES_NOTHING.has(kind);
}
