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
 * ## Four verdicts, not two
 *
 * The first version of this file had two tables and a shrug for everything
 * else, and a sweep over every shipped example found **107 types** falling into
 * that shrug — every gcp, azure, fly, fountain, helm, github and gitlab type in
 * the repository, each reported to a user as "augur has never looked at this",
 * which is not what had happened. augur had looked at gcp and decided not to
 * model it.
 *
 * So there are four:
 *
 * | Verdict | Means | Reported as |
 * |---|---|---|
 * | `mapped` | sent, as a kind, a provider, a region and a size | figures |
 * | `declared-unmapped` | this type, in a modelled provider, carries no rate | `unsupported-kind`, naming the type and the reason |
 * | `provider-not-modelled` | augur models aws and kubernetes; this type's substrate is not one of them | `unsupported-kind`, naming the substrate |
 * | `unknown-type` | a **modelled** provider's type with no row here | `unsupported-kind`, naming this file |
 *
 * The last is the only one that is a defect, and narrowing it to modelled
 * providers is what makes it actionable: before, it meant "either augur has a
 * gap or you are using a substrate augur does not cover", and a reader could
 * not tell which. `coverage-surface.test.ts` walks every shipped example and
 * requires it to be empty.
 *
 * ## Why the second table exists at all
 *
 * `declared-unmapped` and `unknown-type` both end in `unpredicted` with
 * `unsupported-kind` — never a dropped entity and never a zero — and they
 * differ in what the `detail` says. "IAM roles are not priced, and here is why"
 * is an answer. "This lexicon has never heard of `AWS::Foo::Bar`" is a gap in
 * this file. A reader can act on the second and should not file a bug about
 * the first.
 *
 * That is the tri-state of `observation-contract.mdx`'s "absent is not the
 * same as unread" applied to prediction: a nothing that was decided and a
 * nothing that was never considered are different nothings, and collapsing
 * them is how a coverage table rots into a shrug.
 *
 * ## Why a size is a prop name, a type, and not a number
 *
 * `sizeProp` names the declared property the engine should read as the
 * entity's size, and this file never reads it as a quantity. `t3.medium` and
 * `db.r6g.xlarge` are the provider's own vocabulary, which the engine's price
 * model is written against; parsing either into vCPU counts here would put a
 * lossy hop in front of a model that already knows the string.
 *
 * `sizeType` says which of `string` or `number` the property holds, and a
 * value of the other type is **absent** rather than coerced. Without it,
 * `DBInstanceClass: 42` travelled as `"42"` and was matched against a price
 * table it does not appear in — which is the outcome the "absent beats
 * unmatched" argument in `./request.ts` is written against, arriving through
 * the door that argument left open.
 *
 * A row states `sizeProp` only where the property genuinely holds one of those
 * two. A Kubernetes workload's size is its containers' resource requests: an
 * object, per container, over an array. This contract's `size` is one string
 * in the provider's vocabulary and Kubernetes has no such string for a
 * workload, so those rows state none and say so, rather than naming a path
 * that resolves to an array and silently yields nothing.
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
 * existence, and the epic's whole output shape is per hour. `control-plane` is
 * separate from everything because a managed control plane is a flat hourly
 * fee that does not move with the estate's traffic at all — pricing one as
 * `compute` would make it look like something a right-size suggestion could
 * shrink.
 */
export type EngineKind =
  | "compute"
  | "serverless"
  | "control-plane"
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
  "control-plane": true,
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

/** The substrates augur models. Everything else is `provider-not-modelled`. */
export type ModelledProvider = "aws" | "kubernetes";

/** One row of the coverage table: what an entity type becomes on the wire. */
export interface EngineKindMapping {
  /** The engine-side kind. */
  kind: EngineKind;
  /** The substrate, as the engine names it. Its price model is per provider. */
  provider: ModelledProvider;
  /**
   * The declared property whose value is the entity's size, in the provider's
   * own vocabulary. Absent where the type has no size this contract's single
   * `size` string can carry — see the module doc.
   */
  sizeProp?: string;
  /**
   * Which type {@link sizeProp} holds. A value of the other type is absent
   * rather than coerced: a number rendered into a size field an engine matches
   * against a price table of strings is worse than no size at all.
   */
  sizeType?: "string" | "number";
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
 * A type from any other substrate is `provider-not-modelled`, which says that
 * rather than pretending to have missed it.
 */
export const ENGINE_KINDS_BY_ENTITY_TYPE: Readonly<Record<string, EngineKindMapping>> = {
  // ── AWS ──────────────────────────────────────────────────────────
  "AWS::EC2::Instance": { kind: "compute", provider: "aws", sizeProp: "InstanceType", sizeType: "string" },
  "AWS::EC2::Volume": { kind: "block-store", provider: "aws", sizeProp: "Size", sizeType: "number", regionProp: "AvailabilityZone" },
  "AWS::Lambda::Function": { kind: "serverless", provider: "aws", sizeProp: "MemorySize", sizeType: "number" },
  "AWS::RDS::DBInstance": { kind: "database", provider: "aws", sizeProp: "DBInstanceClass", sizeType: "string" },
  "AWS::RDS::DBCluster": { kind: "database", provider: "aws", sizeProp: "DBClusterInstanceClass", sizeType: "string" },
  "AWS::DynamoDB::Table": { kind: "database", provider: "aws", sizeProp: "BillingMode", sizeType: "string" },
  "AWS::ElastiCache::CacheCluster": { kind: "cache", provider: "aws", sizeProp: "CacheNodeType", sizeType: "string" },
  "AWS::SQS::Queue": { kind: "queue", provider: "aws" },
  "AWS::SNS::Topic": { kind: "queue", provider: "aws" },
  "AWS::S3::Bucket": { kind: "object-store", provider: "aws" },
  "AWS::ElasticLoadBalancingV2::LoadBalancer": { kind: "load-balancer", provider: "aws", sizeProp: "Type", sizeType: "string" },
  "AWS::CloudFront::Distribution": { kind: "cdn", provider: "aws" },
  /** A flat hourly fee for the managed control plane. It does not move with the estate's traffic. */
  "AWS::EKS::Cluster": { kind: "control-plane", provider: "aws" },
  /**
   * A set of EC2 instances, and what an EKS estate actually costs. No size:
   * `InstanceTypes` is a list, and this contract's `size` is one string.
   */
  "AWS::EKS::Nodegroup": { kind: "compute", provider: "aws" },
  /** The running thing. Its task definition is the template and carries no rate. */
  "AWS::ECS::Service": { kind: "compute", provider: "aws" },

  // ── Kubernetes ───────────────────────────────────────────────────
  // No `sizeProp` on the five workload kinds. A workload's size is its pod
  // template's container resource requests — an object, per container, over an
  // array — and this contract's `size` is one string in the provider's own
  // vocabulary. Kubernetes has no such string for a workload. Naming
  // `spec.template.spec.containers` here, as the first version did, advertised
  // a column that resolved to an array and therefore to nothing, on every
  // Kubernetes workload in the repository.
  "K8s::Apps::Deployment": { kind: "compute", provider: "kubernetes" },
  "K8s::Apps::StatefulSet": { kind: "compute", provider: "kubernetes" },
  "K8s::Apps::DaemonSet": { kind: "compute", provider: "kubernetes" },
  "K8s::Core::Pod": { kind: "compute", provider: "kubernetes" },
  "K8s::Batch::Job": { kind: "serverless", provider: "kubernetes" },
  "K8s::Batch::CronJob": { kind: "serverless", provider: "kubernetes" },
  // These two do state a size, as a single string in Kubernetes' own
  // vocabulary: a quantity (`20Gi`) and a service type (`LoadBalancer`).
  "K8s::Core::PersistentVolumeClaim": { kind: "block-store", provider: "kubernetes", sizeProp: "spec.resources.requests.storage", sizeType: "string" },
  "K8s::Core::Service": { kind: "load-balancer", provider: "kubernetes", sizeProp: "spec.type", sizeType: "string" },
  "K8s::Networking::Ingress": { kind: "load-balancer", provider: "kubernetes" },
};

/**
 * Types this lexicon has considered and declares it will not send, with the
 * reason each one is not a thing an hourly rate and a saturation axis can be
 * said about.
 *
 * The reasons are the point. Five families run through them:
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
 *  - **A template is not an instance.** A task definition, a launch template
 *    and a scaling policy shape what runs; the thing that runs carries the
 *    figures, and pricing both would count the estate twice.
 *  - **A controller's request is not the thing it creates.** A Kubernetes
 *    custom resource is an instruction to whatever reconciles it. A
 *    `Certificate` costs nothing; the issuer's work and the Secret it writes
 *    are elsewhere in the graph or outside the cluster entirely.
 */
export const DECLARED_UNMAPPED: Readonly<Record<string, string>> = {
  // ── Grants ───────────────────────────────────────────────────────
  "AWS::IAM::Role": "a role is a grant, not a resource traffic flows through: no rate, no capacity, no verdict under a lost zone",
  "AWS::IAM::Policy": "a policy document is a statement about permission; nothing about it saturates or accrues",
  "AWS::IAM::ManagedPolicy": "a policy document is a statement about permission; nothing about it saturates or accrues",
  "AWS::IAM::InstanceProfile": "a wrapper that hands a role to an instance; the instance carries the figures",
  "AWS::S3::BucketPolicy": "a bucket policy is a grant on the bucket beside it, and the bucket carries the figures",
  "AWS::SQS::QueuePolicy": "a queue policy is a grant on the queue beside it, and the queue carries the figures",
  "AWS::Lambda::Permission": "a grant letting one service invoke a function; the function carries the figures",
  "K8s::Rbac::Role": "an RBAC role is a grant; the workloads it admits are what cost and saturate",
  "K8s::Rbac::RoleBinding": "an RBAC binding is a grant; the workloads it admits are what cost and saturate",
  "K8s::Rbac::ClusterRole": "the cluster-scoped twin of an RBAC role, and a grant for the same reason",
  "K8s::Rbac::ClusterRoleBinding": "the cluster-scoped twin of an RBAC binding, and a grant for the same reason",
  "K8s::Core::ServiceAccount": "an identity, not a workload",

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
  "K8s::Core::Namespace": "a boundary the workloads sit inside, and the workloads carry the figures",
  "K8s::Networking::IngressClass": "names which controller handles an Ingress; the controller and the load balancer it creates carry the figures",
  "K8s::Networking::NetworkPolicy": "a filter on edges that already exist, not a thing at either end of one",
  "K8s::Storage::StorageClass": "the kind of disk a claim may ask for; the PersistentVolumeClaim carries the figures",

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
  "K8s::Autoscaling::HorizontalPodAutoscaler": "an instruction about how many replicas to run; the workload it scales carries the figures, and a prediction is at one stated traffic level rather than across a scaling range",
  "K8s::HorizontalPodAutoscaler": "an instruction about how many replicas to run; the workload it scales carries the figures, and a prediction is at one stated traffic level rather than across a scaling range",
  "K8s::Policy::PodDisruptionBudget": "a constraint on voluntary eviction. It shapes what a lost zone does to a workload and has no rate of its own; expressing that constraint to an engine is a resilience input this contract has no field for",
  "K8s::Core::LimitRange": "a default and a ceiling for workloads in a namespace; the workloads carry the figures",
  "K8s::Core::ResourceQuota": "a ceiling on a namespace's total requests; the workloads under it carry the figures",

  // ── A controller's request is not the thing it creates ───────────
  "K8s::Argo::Application": "a request to Argo CD to reconcile a source; whatever it creates is priced where that lands",
  "K8s::Flux::GitRepository": "a source Flux polls; the workloads it reconciles carry the figures",
  "K8s::Flux::Kustomization": "a request to Flux to apply a source; whatever it creates is priced where that lands",
  "K8s::CertManager::Certificate": "a request to an issuer. The certificate costs nothing; the issuer's work and the Secret it writes are elsewhere",
  "K8s::CertManager::ClusterIssuer": "the issuer a certificate request names; it holds no capacity and serves no traffic",
  "K8s::ExternalSecrets::ExternalSecret": "a request to copy a value from an external store into a Secret; neither end is a rate",
  "K8s::ExternalSecrets::ClusterSecretStore": "names where secrets are fetched from; it holds no capacity and serves no traffic",
  "K8s::Monitoring::ServiceMonitor": "tells Prometheus what to scrape; Prometheus is a workload elsewhere in the graph and carries the figures",
  "K8s::Monitoring::PrometheusRule": "alerting and recording rules evaluated by Prometheus, which carries the figures",
  "K8s::Traefik::IngressRoute": "routing handled by the Traefik workload, which carries the figures",
  "K8s::Calico::FelixConfiguration": "tuning for the CNI agent on every node; the nodes carry the figures",
  "K8s::GKE::BackendConfig": "tuning for a Google load balancer an Ingress creates; augur does not model gcp, so neither end is priced here",
  "K8s::NetworkingGKE::ManagedCertificate": "a certificate Google issues for an Ingress; augur does not model gcp",
  "K8s::NetworkingGKEBeta::FrontendConfig": "tuning for a Google load balancer an Ingress creates; augur does not model gcp",

  // ── Configuration and secrets: real, declared, carrying no rate ──
  "K8s::Core::ConfigMap": "configuration the workloads read; it has no rate and no saturation axis of its own",
  "K8s::Core::Secret": "configuration the workloads read; it has no rate and no saturation axis of its own",

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

  // ── chant's own model ────────────────────────────────────────────
  "Chant::Op": "an Op is a procedure chant runs, not a resource an account holds. What an Op creates is priced where that lands; the Op itself exists only in the build",

  // ── This lexicon's own entity ────────────────────────────────────
  "Augur::Profile": "the request's own input — the traffic level to predict at — and not part of the estate being predicted. Sending it would ask an engine to price the question",
};

/**
 * Namespace prefixes for the substrates augur does **not** model, and the
 * sentence each one gets.
 *
 * This is the fix for a shrug. A sweep over every shipped example found 107
 * types falling through to "augur has never heard of this", and the great
 * majority of them were gcp, azure, fly, fountain, helm, github and gitlab
 * types — substrates augur states plainly it does not cover. Reporting a
 * stated boundary as an oversight sends a reader to file a bug that is already
 * answered, and buries the handful of real gaps in ninety false ones.
 *
 * Matched on the type's namespace rather than enumerated one type at a time,
 * because the decision genuinely is per substrate: adding gcp means a table of
 * gcp rows and a price model per gcp kind, not a row.
 */
const UNMODELLED_PROVIDERS: ReadonlyArray<{ prefix: string; substrate: string }> = [
  { prefix: "GCP::", substrate: "Google Cloud (the gcp lexicon)" },
  { prefix: "Microsoft.", substrate: "Azure (the azure lexicon)" },
  { prefix: "Fly::", substrate: "Fly Machines (the fly lexicon)" },
  { prefix: "Fountain::", substrate: "fountain" },
  { prefix: "Helm::", substrate: "Helm (a chart is a package, and what it installs is Kubernetes)" },
  { prefix: "GitHub::", substrate: "GitHub Actions (a workflow is not an estate)" },
  { prefix: "GitLab::", substrate: "GitLab CI (a pipeline is not an estate)" },
  { prefix: "Forgejo::", substrate: "Forgejo Actions (a workflow is not an estate)" },
  { prefix: "Docker::", substrate: "Docker (the docker lexicon)" },
  { prefix: "K3d::", substrate: "k3d (a local cluster nobody is billed for)" },
  { prefix: "K3s::", substrate: "k3s (a cluster on hosts priced where those hosts are declared)" },
  { prefix: "Cpln::", substrate: "Control Plane (the cpln lexicon)" },
  { prefix: "Render::", substrate: "Render (the render lexicon)" },
  { prefix: "Cedar::", substrate: "Cedar (a policy language, with nothing to saturate)" },
  { prefix: "Dogwood::", substrate: "the dogwood temporal dialect inside the cedar lexicon, which is policy rather than estate" },
  { prefix: "Terraform::", substrate: "Terraform (a block in a root module, whose real resources belong to a provider)" },
];

/**
 * chant's own pseudo-entities, which are neither a substrate's nor a gap.
 *
 * `chant:output` (`packages/core/src/stack-output.ts`) is a declared stack
 * output; `chant:aws:defaultTags` and `chant:gcp:defaultAnnotations` are
 * build-time defaults that ride onto other entities. All three are chant
 * talking to itself, the same case as `Augur::Profile`, and a user seeing one
 * reported as a missing row would go looking for a substrate that does not
 * exist.
 */
const CHANT_PSEUDO_PREFIX = "chant:";

/** Why an entity type produced no prediction, in the four shapes this lexicon distinguishes. */
export type CoverageVerdict =
  | { status: "mapped"; mapping: EngineKindMapping }
  | { status: "declared-unmapped"; reason: string }
  | { status: "provider-not-modelled"; substrate: string }
  | { status: "unknown-type" };

/**
 * A CloudFormation **property** type — `AWS::S3::Bucket.VersioningConfiguration`
 * — recognised by the dot. These are nested blocks of the resource above them
 * that became entities of their own in the build; there are hundreds, they are
 * never separately priced, and enumerating them one row at a time would bury
 * the table's real decisions under boilerplate.
 */
function isAwsPropertyType(entityType: string): boolean {
  return entityType.startsWith("AWS::") && entityType.includes(".");
}

/**
 * Look one entity type up.
 *
 * Total by construction: every type resolves to one of the four states, and
 * there is no fifth arm for "dropped". That is the property the caller in
 * `./predict-behaviour.ts` relies on to guarantee every entity it was asked
 * about lands in `entities` or in `unpredicted`.
 *
 * `hasOwnProperty` rather than a truthiness check on both tables: these are
 * bare object literals, so `ENGINE_KINDS_BY_ENTITY_TYPE["constructor"]` is a
 * function and an entity named after a prototype member would resolve to a
 * mapping that does not exist.
 */
export function coverageFor(entityType: string): CoverageVerdict {
  if (Object.prototype.hasOwnProperty.call(ENGINE_KINDS_BY_ENTITY_TYPE, entityType)) {
    return { status: "mapped", mapping: ENGINE_KINDS_BY_ENTITY_TYPE[entityType] };
  }
  if (Object.prototype.hasOwnProperty.call(DECLARED_UNMAPPED, entityType)) {
    return { status: "declared-unmapped", reason: DECLARED_UNMAPPED[entityType] };
  }
  if (entityType.startsWith(CHANT_PSEUDO_PREFIX)) {
    return {
      status: "declared-unmapped",
      reason:
        "one of chant's own build-time entities rather than something an account holds — a declared " +
        "output, or a default that rides onto the resources beside it. It is never created and never " +
        "billed",
    };
  }
  if (isAwsPropertyType(entityType)) {
    return {
      status: "declared-unmapped",
      reason:
        "a CloudFormation property type: a nested block of the resource above it, which became an " +
        "entity of its own in the build. The resource carries the figures, and pricing the block as " +
        "well would count part of the estate twice",
    };
  }
  for (const { prefix, substrate } of UNMODELLED_PROVIDERS) {
    if (entityType.startsWith(prefix)) return { status: "provider-not-modelled", substrate };
  }
  return { status: "unknown-type" };
}

/**
 * The `detail` an `unpredicted` entry carries, naming the kind in every case.
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
  if (verdict.status === "provider-not-modelled") {
    return (
      `${entityType} belongs to ${verdict.substrate}, which the augur coverage table does not model. ` +
      "augur maps aws and kubernetes entity types; a substrate is added by writing a table of its " +
      "kinds, not by adding a row. This is a stated boundary rather than a gap — nothing needs filing."
    );
  }
  return (
    `${entityType} has no row in the augur coverage table — it is a type from a substrate augur does ` +
    "model, and is neither mapped to an engine kind nor declared unmapped, so this lexicon has no " +
    "opinion about it rather than a stated one. Add a row to ENGINE_KINDS_BY_ENTITY_TYPE or to " +
    "DECLARED_UNMAPPED in lexicons/augur/src/mapping.ts."
  );
}

/**
 * Compare two strings by UTF-16 code unit.
 *
 * Not `localeCompare`, which reads the ambient locale: under `sv-SE` and
 * `et-EE` it orders these type names differently from `en-US`, which would
 * make the request's bytes — and therefore the golden fixture, and therefore
 * any declared-versus-live delta — a function of the machine that built them.
 * `./request.ts`'s module doc says "no environment"; the locale is one.
 */
export const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

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
  return [...mapped, ...unmapped].sort((a, b) => byCodeUnit(a.entityType, b.entityType));
}
