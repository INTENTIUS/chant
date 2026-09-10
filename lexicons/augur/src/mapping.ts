/**
 * The coverage table (#2357): which chant entity types this lexicon can put in
 * front of a behaviour engine, and which it declares it cannot.
 *
 * The epic's engine takes "entities with a kind, a provider, a region and a
 * size". Those four words are the engine's vocabulary and none of them is
 * chant's: chant knows `AWS::RDS::DBInstance` and `K8s::Apps::StatefulSet`,
 * and an engine that had to learn either of those would be a second chant.
 * So the translation lives here, on chant's side, and it is a table rather
 * than a heuristic — a heuristic over type names would map
 * `AWS::EC2::VolumeAttachment` to storage and price a join table.
 *
 * ## Two tables, and why the second one exists
 *
 * {@link ENGINE_KINDS_BY_ENTITY_TYPE} is the mapping. {@link DECLARED_UNMAPPED}
 * is the list of types this lexicon has looked at and decided have no engine
 * equivalent, each with the reason. A type in neither table is simply unknown
 * to the lexicon, which is a third state and not the same one.
 *
 * Both roads end in `unpredicted` with `unsupported-kind` — never a dropped
 * entity and never a zero — and they differ in what the `detail` says, which
 * is the whole value of writing the second table down. "IAM roles are not
 * priced, and here is why" is an answer. "This lexicon has never heard of
 * `AWS::Foo::Bar`" is a gap in this file. A reader of the report can act on
 * the second and should not file a bug about the first.
 *
 * That is the tri-state of `observation-contract.mdx`'s "absent is not the
 * same as unread" applied to prediction: a nothing that was decided and a
 * nothing that was never considered are different nothings, and collapsing
 * them is how a coverage table rots into a shrug.
 *
 * ## Why a size is a prop name and not a number
 *
 * `sizeProp` names the declared property the engine should read as the
 * entity's size, and this file never reads it as a quantity. `t3.medium` and
 * `db.r6g.xlarge` are the provider's own vocabulary, which the engine's price
 * model is written against; parsing either into vCPU counts here would put a
 * lossy hop in front of a model that already knows the string. Where the
 * declaration states no size, the request carries none rather than a default
 * — a guessed size is a guessed price.
 */

/**
 * What an engine is asked to price. Deliberately small and deliberately
 * abstract: these are the categories a cost-and-saturation model actually
 * distinguishes, not a taxonomy of every product a cloud sells.
 *
 * A kind is here when the engine would price it differently or when its
 * saturation axis differs. `cache` is separate from `database` because a cache
 * saturates on memory and a database on IO; `serverless` is separate from
 * `compute` because one is priced per invocation and the other per hour of
 * existence, and the epic's whole output shape is per hour.
 */
export type EngineKind =
  | "compute"
  | "serverless"
  | "database"
  | "cache"
  | "queue"
  | "object-store"
  | "block-store"
  | "load-balancer"
  | "cdn";

const ENGINE_KIND_WITNESS: Record<EngineKind, true> = {
  compute: true,
  serverless: true,
  database: true,
  cache: true,
  queue: true,
  "object-store": true,
  "block-store": true,
  "load-balancer": true,
  cdn: true,
};

/**
 * Every legal {@link EngineKind}, derived from a total witness rather than
 * written out by hand — the construction `behaviour.ts` uses for
 * `BEHAVIOUR_BASES` and for the same reason: a hand-written array is checked
 * for having legal members and never for having all of them.
 */
export const ENGINE_KINDS: readonly EngineKind[] = Object.keys(
  ENGINE_KIND_WITNESS,
) as EngineKind[];

/** True when `value` is a legal {@link EngineKind}. */
export function isEngineKind(value: unknown): value is EngineKind {
  return typeof value === "string" && (ENGINE_KINDS as readonly string[]).includes(value);
}

/** One row of the coverage table: what an entity type becomes on the wire. */
export interface EngineKindMapping {
  /** The engine-side kind. */
  kind: EngineKind;
  /** The substrate, as the engine names it. Its price model is per provider. */
  provider: "aws" | "kubernetes";
  /**
   * The declared property whose value is the entity's size, in the provider's
   * own vocabulary. Absent where the type has no size to state — an S3 bucket
   * is not a t3.medium of anything.
   */
  sizeProp?: string;
  /**
   * The declared property naming the region or zone this entity sits in, where
   * the type states one of its own. Most do not: a CloudFormation stack's
   * resources inherit the stack's region, which reaches the request as the
   * caller's `region` instead.
   */
  regionProp?: string;
}

/**
 * The mapping, keyed by chant `entityType`.
 *
 * AWS and Kubernetes only, and that is a stated boundary rather than an
 * oversight: those are the two substrates whose entities the epic's own
 * fixture and the deep-read table are written against, and a row added for a
 * substrate nobody has priced would be a claim this lexicon cannot support.
 * Every other lexicon's types are unknown here and report as such.
 */
export const ENGINE_KINDS_BY_ENTITY_TYPE: Readonly<Record<string, EngineKindMapping>> = {
  // ── AWS ──────────────────────────────────────────────────────────
  "AWS::EC2::Instance": { kind: "compute", provider: "aws", sizeProp: "InstanceType" },
  "AWS::EC2::Volume": { kind: "block-store", provider: "aws", sizeProp: "Size", regionProp: "AvailabilityZone" },
  "AWS::Lambda::Function": { kind: "serverless", provider: "aws", sizeProp: "MemorySize" },
  "AWS::RDS::DBInstance": { kind: "database", provider: "aws", sizeProp: "DBInstanceClass" },
  "AWS::DynamoDB::Table": { kind: "database", provider: "aws", sizeProp: "BillingMode" },
  "AWS::ElastiCache::CacheCluster": { kind: "cache", provider: "aws", sizeProp: "CacheNodeType" },
  "AWS::SQS::Queue": { kind: "queue", provider: "aws" },
  "AWS::S3::Bucket": { kind: "object-store", provider: "aws" },
  "AWS::ElasticLoadBalancingV2::LoadBalancer": { kind: "load-balancer", provider: "aws", sizeProp: "Type" },
  "AWS::CloudFront::Distribution": { kind: "cdn", provider: "aws" },

  // ── Kubernetes ───────────────────────────────────────────────────
  // A workload's size is its pod template's resource requests, which is the
  // number a scheduler bin-packs on and the closest thing Kubernetes has to
  // an instance type. `spec.replicas` is not a size, it is a count, and the
  // engine derives the cluster's bill from the two together.
  "K8s::Apps::Deployment": { kind: "compute", provider: "kubernetes", sizeProp: "spec.template.spec.containers" },
  "K8s::Apps::StatefulSet": { kind: "compute", provider: "kubernetes", sizeProp: "spec.template.spec.containers" },
  "K8s::Apps::DaemonSet": { kind: "compute", provider: "kubernetes", sizeProp: "spec.template.spec.containers" },
  "K8s::Batch::Job": { kind: "serverless", provider: "kubernetes", sizeProp: "spec.template.spec.containers" },
  "K8s::Batch::CronJob": { kind: "serverless", provider: "kubernetes", sizeProp: "spec.jobTemplate.spec.template.spec.containers" },
  "K8s::Core::PersistentVolumeClaim": { kind: "block-store", provider: "kubernetes", sizeProp: "spec.resources.requests.storage" },
  "K8s::Core::Service": { kind: "load-balancer", provider: "kubernetes", sizeProp: "spec.type" },
  "K8s::Networking::Ingress": { kind: "load-balancer", provider: "kubernetes" },
};

/**
 * Types this lexicon has considered and declares it will not send, with the
 * reason each one is not a thing an hourly rate and a saturation axis can be
 * said about.
 *
 * The reasons are the point. Three families run through them:
 *
 *  - **A grant is not a resource.** An IAM role, a Kubernetes RBAC binding and
 *    a bucket policy are statements about who may act, and they have no rate,
 *    no capacity and no behaviour under a lost zone.
 *  - **A boundary is not a node.** A VPC, a subnet and a namespace are where
 *    other entities live. Sending them as nodes would draw a line from every
 *    resource to its VPC and price the drawing; their real contribution to a
 *    prediction is zone membership, which reaches the engine through
 *    `edgeCoverage.containmentEdges` instead.
 *  - **A meter chant cannot read.** A log group is priced by ingested volume
 *    and a WAF by inspected requests. Both cost real money and neither number
 *    is in the declaration, so the honest answer is `unsupported-kind` rather
 *    than a figure derived from nothing.
 */
export const DECLARED_UNMAPPED: Readonly<Record<string, string>> = {
  // Grants.
  "AWS::IAM::Role": "a role is a grant, not a resource traffic flows through: no rate, no capacity, no verdict under a lost zone",
  "AWS::IAM::Policy": "a policy document is a statement about permission; nothing about it saturates or accrues",
  "AWS::IAM::ManagedPolicy": "a policy document is a statement about permission; nothing about it saturates or accrues",
  "AWS::S3::BucketPolicy": "a bucket policy is a grant on the bucket beside it, and the bucket carries the figures",
  "AWS::SQS::QueuePolicy": "a queue policy is a grant on the queue beside it, and the queue carries the figures",
  "K8s::Rbac::Role": "an RBAC role is a grant; the workloads it admits are what cost and saturate",
  "K8s::Rbac::RoleBinding": "an RBAC binding is a grant; the workloads it admits are what cost and saturate",
  "K8s::Core::ServiceAccount": "an identity, not a workload",

  // Boundaries, and the wiring that puts things inside them.
  "AWS::EC2::VPC": "a network boundary rather than a node: its contribution to a prediction is the zone membership that reaches the engine as containment coverage",
  "AWS::EC2::Subnet": "a network boundary rather than a node: its contribution to a prediction is the zone membership that reaches the engine as containment coverage",
  "AWS::EC2::SecurityGroup": "a filter on edges that already exist, not a thing at either end of one",
  "AWS::EC2::RouteTable": "routing, which decides where an edge goes and is not itself at either end of one",
  "AWS::EC2::Route": "routing, which decides where an edge goes and is not itself at either end of one",
  "AWS::EC2::SubnetRouteTableAssociation": "an association between two boundaries; nothing flows through it that does not already flow through them",
  "AWS::EC2::InternetGateway": "a boundary crossing rather than a resource: no rate of its own and no capacity to saturate",
  "AWS::EC2::VPCGatewayAttachment": "an attachment between two boundaries, and neither end is priced by it",
  "AWS::RDS::DBSubnetGroup": "the set of subnets a database may sit in; the database carries the figures",
  "K8s::Core::Namespace": "a boundary the workloads sit inside, and the workloads carry the figures",

  // Meters chant cannot read.
  "AWS::Logs::LogGroup": "priced by the volume ingested into it, which the declaration does not state and no engine can infer from a graph",
  "AWS::WAFv2::WebACL": "priced by the requests inspected through it, which the declaration does not state",
  "AWS::EC2::NatGateway": "priced as an hourly rate plus a per-gigabyte meter on everything that crosses it. The declaration states the first and nothing at all about the second, and no engine kind here models a half-known price — a figure covering the hourly half alone would read as the cost of the gateway and be wrong by whatever the traffic did",
  "AWS::EC2::EIP": "priced only while it is attached to nothing, which is a fact about the running account rather than about the declaration",

  // Not a resource at all.
  "AWS::CloudFormation::Parameter": "a template input, not a thing the account holds. It shapes what is created and is never created itself",

  // Configuration and secrets: real, declared, and carrying no rate.
  "K8s::Core::ConfigMap": "configuration the workloads read; it has no rate and no saturation axis of its own",
  "K8s::Core::Secret": "configuration the workloads read; it has no rate and no saturation axis of its own",

  // This lexicon's own entity.
  "Augur::Profile": "the request's own input — the traffic level to predict at — and not part of the estate being predicted. Sending it would ask an engine to price the question",
};

/** Why an entity type produced no prediction, in the two shapes this lexicon distinguishes. */
export type CoverageVerdict =
  | { status: "mapped"; mapping: EngineKindMapping }
  | { status: "declared-unmapped"; reason: string }
  | { status: "unknown-type" };

/**
 * Look one entity type up in the two tables.
 *
 * Total by construction: every type resolves to one of the three states, and
 * there is no fourth arm for "dropped". That is the property the caller in
 * `./predict-behaviour.ts` relies on to guarantee every entity it was asked
 * about lands in `entities` or in `unpredicted`.
 */
export function coverageFor(entityType: string): CoverageVerdict {
  const mapping = Object.prototype.hasOwnProperty.call(ENGINE_KINDS_BY_ENTITY_TYPE, entityType)
    ? ENGINE_KINDS_BY_ENTITY_TYPE[entityType]
    : undefined;
  if (mapping) return { status: "mapped", mapping };
  const reason = Object.prototype.hasOwnProperty.call(DECLARED_UNMAPPED, entityType)
    ? DECLARED_UNMAPPED[entityType]
    : undefined;
  if (reason !== undefined) return { status: "declared-unmapped", reason };
  return { status: "unknown-type" };
}

/**
 * The `detail` an `unpredicted` entry carries, naming the kind in both cases.
 *
 * The issue asks that a declared-unmapped kind "produce a refusal naming the
 * kind". The kind is named here, in the per-entity decline, because that is
 * the only place in this contract with a per-entity axis: a
 * `BehaviourRefusalReport` is a statement about the whole run and has no
 * `entities` key by design, so a report-level refusal for one unmapped
 * bucket would take the other nineteen entities' figures down with it.
 */
export function unmappedDetail(entityType: string, verdict: CoverageVerdict): string {
  if (verdict.status === "declared-unmapped") {
    return `${entityType} is declared unmapped by the augur coverage table: ${verdict.reason}.`;
  }
  return (
    `${entityType} has no row in the augur coverage table — it is neither mapped to an engine kind ` +
    `nor declared unmapped, so this lexicon has no opinion about it rather than a stated one. ` +
    `Add a row to ENGINE_KINDS_BY_ENTITY_TYPE or to DECLARED_UNMAPPED in ` +
    `lexicons/augur/src/mapping.ts.`
  );
}

/** One printable row of the coverage table, for docs and for `augurCoverageTable()`. */
export interface CoverageRow {
  entityType: string;
  kind: EngineKind | "—";
  provider: string;
  size: string;
  note: string;
}

/**
 * The whole table, sorted, as rows. Exported because the docs page and the
 * lexicon's `coverageReport()` both render it, and a table transcribed by hand
 * into prose is a table that stops being true.
 */
export function augurCoverageTable(): CoverageRow[] {
  const mapped: CoverageRow[] = Object.entries(ENGINE_KINDS_BY_ENTITY_TYPE).map(
    ([entityType, m]) => ({
      entityType,
      kind: m.kind,
      provider: m.provider,
      size: m.sizeProp ?? "—",
      note: m.regionProp ? `region from ${m.regionProp}` : "region from the request",
    }),
  );
  const unmapped: CoverageRow[] = Object.entries(DECLARED_UNMAPPED).map(([entityType, reason]) => ({
    entityType,
    kind: "—" as const,
    provider: "—",
    size: "—",
    note: reason,
  }));
  return [...mapped, ...unmapped].sort((a, b) => a.entityType.localeCompare(b.entityType));
}
