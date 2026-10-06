/**
 * A starter policy pack for gates (chant#3182): rules a platform team writes
 * once and puts on every gate, the way Sentinel or OPA policies run against a
 * Terraform plan. Each builder returns one cedar `Policy` over the plan
 * summary core puts in `context.plan` (`GatePlanSummary`, declared by
 * `GATE_CEDAR_SCHEMA`), so an Op needs no context code of its own.
 *
 * ```ts
 * import { gatePolicy, protectStateful, capDeletes, permitLowRiskAgents } from "@intentius/chant-lexicon-cedar";
 *
 * export const prodGate = gatePolicy("prod", [
 *   protectStateful(),
 *   capDeletes({ max: 5 }),
 *   permitLowRiskAgents({ maxChanges: 10 }),
 * ]);
 *
 * gate("approve-prod", { plan: plan.out.planDigest, approval: { policy: prodGate, mode: "log-only" } });
 * ```
 *
 * How the rules combine is Cedar's: a `forbid` beats every `permit`, and with
 * no permit the answer is deny. The pack's forbids are the limits and its
 * permits say when an agent may pass a gate on its own. A gate's quorum is
 * unchanged by any of it, since a deny never removes a human's approval
 * (`tallyGateApprovals`), and in `log-only` mode, the default, every decision
 * is recorded and none binds, so a team can watch a rule against real plans
 * before switching the gate to `enforce`.
 *
 * Every forbid fails closed: on a gate whose context has no `plan` (no change
 * set behind the gate's `plan`), it applies. A limit nobody can check is not
 * a reason to let an agent through.
 */

import type { Declarable } from "@intentius/chant/declarable";
import { Policy, type EntityTypeName, type PolicyRef, type PolicyScope } from "./generated/index";
import { escapeCedarString } from "./policy-text";
import { GATE_AGENT_TYPE, PASS_GATE_ACTION } from "./gate-policy";

/**
 * Resource types whose delete or replacement loses data: databases, buckets,
 * volumes, queues with retention, and keys. Terraform-provider type names
 * and the CloudFormation names the aws lexicon plans with.
 */
export const STATEFUL_TYPES: readonly string[] = [
  // AWS, terraform
  "aws_db_instance", "aws_rds_cluster", "aws_rds_cluster_instance", "aws_rds_global_cluster",
  "aws_dynamodb_table", "aws_dynamodb_global_table", "aws_s3_bucket", "aws_efs_file_system",
  "aws_ebs_volume", "aws_elasticache_cluster", "aws_elasticache_replication_group",
  "aws_docdb_cluster", "aws_neptune_cluster", "aws_redshift_cluster", "aws_opensearch_domain",
  "aws_elasticsearch_domain", "aws_msk_cluster", "aws_kinesis_stream", "aws_sqs_queue",
  "aws_kms_key", "aws_secretsmanager_secret", "aws_backup_vault", "aws_fsx_lustre_file_system",
  // AWS, CloudFormation
  "AWS::RDS::DBInstance", "AWS::RDS::DBCluster", "AWS::RDS::GlobalCluster", "AWS::DynamoDB::Table",
  "AWS::DynamoDB::GlobalTable", "AWS::S3::Bucket", "AWS::EFS::FileSystem", "AWS::EC2::Volume",
  "AWS::ElastiCache::CacheCluster", "AWS::ElastiCache::ReplicationGroup", "AWS::DocDB::DBCluster",
  "AWS::Neptune::DBCluster", "AWS::Redshift::Cluster", "AWS::OpenSearchService::Domain",
  "AWS::MSK::Cluster", "AWS::Kinesis::Stream", "AWS::SQS::Queue", "AWS::KMS::Key",
  "AWS::SecretsManager::Secret", "AWS::Backup::BackupVault",
  // Google Cloud
  "google_sql_database_instance", "google_sql_database", "google_storage_bucket",
  "google_bigquery_dataset", "google_bigquery_table", "google_spanner_instance",
  "google_spanner_database", "google_compute_disk", "google_filestore_instance",
  "google_redis_instance", "google_kms_crypto_key", "google_bigtable_instance",
  // Azure
  "azurerm_mssql_server", "azurerm_mssql_database", "azurerm_postgresql_flexible_server",
  "azurerm_mysql_flexible_server", "azurerm_storage_account", "azurerm_cosmosdb_account",
  "azurerm_managed_disk", "azurerm_redis_cache", "azurerm_key_vault",
];

/** Who a rule speaks about: agent principals only, or every approver. */
export type GatePackAppliesTo = "agents" | "everyone";

interface RuleBase {
  /** The policy's `@id`, recorded in every decision it determines. Each builder has a default. */
  id?: string;
  /** Default `"everyone"` for a forbid. A human's approval still counts toward the quorum whatever a forbid says. */
  appliesTo?: GatePackAppliesTo;
}

// The generated scope types are narrowed to the project's own schema; these
// names are the gate schema's (`GATE_CEDAR_SCHEMA`).
const AGENT = GATE_AGENT_TYPE as EntityTypeName;
const PASS_GATE = PASS_GATE_ACTION as unknown as PolicyRef;

const set = (values: readonly string[]): string => `[${values.map((v) => `"${escapeCedarString(v)}"`).join(", ")}]`;

function count(name: string, value: number | undefined, fallback: number): number {
  const n = value ?? fallback;
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a whole number of at least 0, got ${n}`);
  return n;
}

function nonEmpty(name: string, values: readonly string[] | undefined): readonly string[] {
  if (!values || values.length === 0 || values.some((v) => typeof v !== "string" || v === "")) {
    throw new Error(`${name} needs at least one non-empty name`);
  }
  return values;
}

function principal(appliesTo: GatePackAppliesTo | undefined, fallback: GatePackAppliesTo): PolicyScope {
  return (appliesTo ?? fallback) === "agents" ? { is: AGENT } : {};
}

/** A forbid on `PassGate` that applies when there is no plan summary, or when `condition` holds. `condition` reads `context.plan`. */
function forbid(id: string, appliesTo: GatePackAppliesTo | undefined, condition: string, description: string): Declarable {
  return new Policy({
    effect: "forbid",
    principal: principal(appliesTo, "everyone"),
    action: { eq: PASS_GATE },
    // Written as `unless`, so the validator sees `context has plan` guard the
    // read of it (it tracks a `has` through `&&`): the forbid applies unless
    // there is a plan and the condition does not hold.
    unless: [`context has plan && !(${condition})`],
    annotations: { id, description },
  });
}

export interface CapDeletesOptions extends RuleBase {
  /** The most deletes a plan may carry. Default 0. */
  max?: number;
}

/** Forbid a plan that deletes more than `max` resources. Default id `cap-deletes`. */
export function capDeletes(options: CapDeletesOptions = {}): Declarable {
  const max = count("capDeletes: max", options.max, 0);
  return forbid(
    options.id ?? "cap-deletes", options.appliesTo,
    `context.plan.deletes > ${max}`,
    `A plan may delete at most ${max} resources.`,
  );
}

export interface CapReplacementsOptions extends RuleBase {
  /** The most replacements a plan may carry. Default 0. */
  max?: number;
}

/** Forbid a plan that replaces more than `max` resources. Default id `cap-replacements`. */
export function capReplacements(options: CapReplacementsOptions = {}): Declarable {
  const max = count("capReplacements: max", options.max, 0);
  return forbid(
    options.id ?? "cap-replacements", options.appliesTo,
    `context.plan.replaces > ${max}`,
    `A plan may replace at most ${max} resources.`,
  );
}

export interface ProtectStatefulOptions extends RuleBase {
  /** The types that hold state. Default {@link STATEFUL_TYPES}. */
  types?: readonly string[];
  /** Forbid deletes of these types. Default true. */
  deletes?: boolean;
  /** Forbid replacements of these types, which delete the old object too. Default true. */
  replacements?: boolean;
}

/**
 * Forbid a plan that deletes or replaces a resource of a stateful type: an
 * RDS instance, a DynamoDB table, a bucket. Default id `protect-stateful`.
 */
export function protectStateful(options: ProtectStatefulOptions = {}): Declarable {
  const types = set(nonEmpty("protectStateful: types", options.types ?? STATEFUL_TYPES));
  const deletes = options.deletes ?? true;
  const replacements = options.replacements ?? true;
  if (!deletes && !replacements) throw new Error("protectStateful: deletes and replacements are both off, so the rule forbids nothing");
  const conditions = [
    ...(deletes ? [`context.plan.deletedTypes.containsAny(${types})`] : []),
    ...(replacements ? [`context.plan.replacedTypes.containsAny(${types})`] : []),
  ];
  return forbid(
    options.id ?? "protect-stateful", options.appliesTo,
    conditions.length === 1 ? conditions[0] : `(${conditions.join(" || ")})`,
    `A plan may not ${[deletes ? "delete" : "", replacements ? "replace" : ""].filter(Boolean).join(" or ")} a resource that holds state.`,
  );
}

export interface AllowRegionsOptions extends RuleBase {
  regions: readonly string[];
}

/** Forbid a plan that changes anything outside these regions. Default id `allow-regions`. */
export function allowRegions(options: AllowRegionsOptions): Declarable {
  const regions = nonEmpty("allowRegions: regions", options.regions);
  return forbid(
    options.id ?? "allow-regions", options.appliesTo,
    `!${set(regions)}.containsAll(context.plan.regions)`,
    `A plan may change resources only in ${regions.join(", ")}.`,
  );
}

export interface RequireCreateTagsOptions extends RuleBase {
  /** Tag (or label) keys every created resource must carry. */
  keys: readonly string[];
  /**
   * Also forbid creates that carry no tags attribute at all. Default false,
   * because many types have no tags (an IAM policy attachment, a route), and
   * a create with tags left unset reads the same.
   */
  strict?: boolean;
}

/**
 * Forbid a plan whose tagged creates do not all carry `keys`. Reads
 * `tags`, `tags_all` and `labels`. Default id `require-create-tags`.
 */
export function requireCreateTags(options: RequireCreateTagsOptions): Declarable {
  const keys = nonEmpty("requireCreateTags: keys", options.keys);
  const missing = `(context.plan.taggedCreates > 0 && !context.plan.createTagKeys.containsAll(${set(keys)}))`;
  return forbid(
    options.id ?? "require-create-tags", options.appliesTo,
    options.strict ? `(${missing} || context.plan.untaggedCreates > 0)` : missing,
    `Every created resource carries the tags ${keys.join(", ")}.`,
  );
}

export interface PermitLowRiskAgentsOptions {
  /** Default id `permit-low-risk-agents`. */
  id?: string;
  /** The most changes (creates, updates, replaces, deletes) a low-risk plan has. Default 10. */
  maxChanges?: number;
}

/**
 * Permit an agent to pass a gate on its own for a plan that deletes and
 * replaces nothing, changes at most `maxChanges` resources, and planned
 * every member in full (no failed member, no hole). In `enforce` mode that
 * permit passes the gate; any forbid in the same set still wins.
 */
export function permitLowRiskAgents(options: PermitLowRiskAgentsOptions = {}): Declarable {
  const max = count("permitLowRiskAgents: maxChanges", options.maxChanges, 10);
  return new Policy({
    effect: "permit",
    principal: { is: AGENT },
    action: { eq: PASS_GATE },
    when: [
      "context has plan && " +
        `context.plan.deletes == 0 && context.plan.replaces == 0 && context.plan.changes <= ${max} && ` +
        "context.plan.failed == 0 && context.plan.holes == 0",
    ],
    annotations: {
      id: options.id ?? "permit-low-risk-agents",
      description: `An agent may pass a plan that deletes and replaces nothing and changes at most ${max} resources.`,
    },
  });
}

/** Permit an agent to pass a plan that only changes tags or labels. Default id `permit-tag-only-agents`. */
export function permitTagOnlyAgents(options: { id?: string } = {}): Declarable {
  return new Policy({
    effect: "permit",
    principal: { is: AGENT },
    action: { eq: PASS_GATE },
    when: ["context has plan && context.plan.tagOnly && context.plan.failed == 0 && context.plan.holes == 0"],
    annotations: {
      id: options.id ?? "permit-tag-only-agents",
      description: "An agent may pass a plan that only changes tags or labels.",
    },
  });
}

export interface StarterGatePoliciesOptions {
  /** {@link capDeletes}'s max. Default 0. */
  maxDeletes?: number;
  /** {@link capReplacements}'s max. Default: no cap beyond {@link protectStateful}. */
  maxReplacements?: number;
  /** {@link protectStateful}'s types. Default {@link STATEFUL_TYPES}. */
  statefulTypes?: readonly string[];
  /** {@link allowRegions}. Absent, regions are not limited. */
  regions?: readonly string[];
  /** {@link requireCreateTags}. Absent, tags are not required. */
  requiredTags?: readonly string[];
  /** {@link permitLowRiskAgents}'s maxChanges. Default 10. */
  agentMaxChanges?: number;
}

/**
 * The pack as one record for `gatePolicy(name, starterGatePolicies(...))`:
 * stateful types protected, deletes capped, regions and tags when given,
 * and the two agent permits.
 */
export function starterGatePolicies(options: StarterGatePoliciesOptions = {}): Record<string, Declarable> {
  return {
    protectStateful: protectStateful(options.statefulTypes ? { types: options.statefulTypes } : {}),
    capDeletes: capDeletes({ max: options.maxDeletes ?? 0 }),
    ...(options.maxReplacements !== undefined ? { capReplacements: capReplacements({ max: options.maxReplacements }) } : {}),
    ...(options.regions ? { allowRegions: allowRegions({ regions: options.regions }) } : {}),
    ...(options.requiredTags ? { requireCreateTags: requireCreateTags({ keys: options.requiredTags }) } : {}),
    permitLowRiskAgents: permitLowRiskAgents(options.agentMaxChanges !== undefined ? { maxChanges: options.agentMaxChanges } : {}),
    permitTagOnlyAgents: permitTagOnlyAgents(),
  };
}
