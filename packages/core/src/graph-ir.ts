import { relative, isAbsolute } from "node:path";
import { AttrRef } from "./attrref";
import { isAttrRefLike } from "./utils";
import { type Declarable, isDeclarable } from "./declarable";
import { isLexiconOutput, type LexiconOutput } from "./lexicon-output";
import { getProvenance } from "./provenance";
import { INTRINSIC_MARKER } from "./intrinsic";
import { subTemplateRefs } from "./graph-sub-template";
import type { ResourceMetadata } from "./lexicon";
import type { RootRead, UnobservedEntity } from "./observation";

export { subTemplateRefs };

/**
 * Graph IR — the engine-neutral, lint-gated representation of a project's
 * resolved infrastructure graph. Painters (mermaid, graphviz, custom SVG) and
 * the agentic diagrammer consume this; it is a pure function of lint-clean
 * source. Every node traces to the file that declared it; every edge is a real
 * cross-resource reference, either an `AttrRef` this module resolves itself or
 * an {@link EntityReference} the producing lexicon resolved (#2265).
 *
 * Emitted by `chant graph --format ir`. See issue #493 / epic #492.
 */

/** Where in the source a node came from. Entity-level (file), not a line map. */
export interface SourceLoc {
  /** Path of the declaring file, relative to the project root when possible. */
  file: string;
  /**
   * Line number, when available. Provenance is entity-level today, so this is
   * usually absent — reserved for a future source map.
   */
  line?: number;
}

/** A reference in an attribute projection: `<producer>.<attribute>`. */
export interface AttrRefEnvelope {
  $ref: string;
}

/**
 * A CloudFormation `Fn::Sub` in an attribute projection (#4373), in place of
 * `{ $intrinsic: true }`. `$sub` is the template exactly as it serializes, so
 * `${assets.Arn}/*` names the producer and attribute a reader would otherwise
 * have to guess. `$vars` is the two-argument form's variable map, each value
 * projected like any other attr. Every `${Name}` or `${Name.Attr}` in the
 * template that names a node, and every reference in `$vars`, is also an edge.
 * `${!Literal}` (CloudFormation's escape), pseudo-parameters (`${AWS::Region}`)
 * and names `$vars` binds are not.
 */
export interface SubEnvelope {
  $sub: string;
  $vars?: Record<string, unknown>;
}

/** One resource in the graph. */
export interface IRNode {
  /** Logical name (the export name, or composite-expanded name). */
  id: string;
  /** Resource type, e.g. "GkeCluster". */
  kind: string;
  /** Lexicon the resource belongs to, e.g. "gcp". */
  lexicon: string;
  /**
   * Name of the composite *type* that expanded this node, when it came from one
   * (e.g. "CockroachDbCluster").
   */
  compositeParent?: string;
  /**
   * The composite *instance* (export name) this node belongs to — shared by every
   * node from the same composite call. Detail tiers collapse on this (#494).
   */
  compositeInstance?: string;
  /** Literal/const/ref-resolved props. References appear as `{ $ref }`. */
  attrs: Record<string, unknown>;
  /** Where the node was declared. */
  sourceLoc?: SourceLoc;
  /**
   * Live-only (`chant graph --live`): the observed physical identifier
   * (id / ARN). Absent for source-derived IR. The reference resolver (#778)
   * indexes on this to reconstruct edges from live resource references.
   */
  physicalId?: string;
  /**
   * Live-only: ownership verdict read from the resource's marker (#119/#120).
   * `owned` = chant-managed. Absent for source-derived IR.
   */
  ownership?: "owned" | "foreign";
  /**
   * Live-only, undeclared nodes: the declared entity this node's
   * owner-reference chain resolves to (#1077) — a Pod a declared Deployment's
   * controller created, for instance. Presence of this field is what an
   * overlay reads to paint the node `runtime` instead of `warn`/foreign; a
   * node without it (including every declared, source-derived node) is
   * unaffected.
   */
  runtimeOwner?: string;
  /**
   * On an instance node of a `count` or `for_each` block (#4454): the block
   * node's id. The node's own id is that id followed by {@link instanceKey},
   * `aws_eip.pool[0]` under `aws_eip.pool`, and the block node stays in the
   * graph as the rollup. Absent on every other node. See `./instance-nodes.ts`.
   */
  instanceOf?: string;
  /**
   * With {@link instanceOf}: the block's own instance key as the engine
   * prints it, `[0]` or `["a"]`. Absent on an instance that only an
   * expanded enclosing scope makes (#4486), a block without `count` under
   * `module "app" { count = 2 }`.
   */
  instanceKey?: string;
  /**
   * With {@link instanceOf}, under an expanded enclosing scope (#4486): that
   * scope's path as the engine prints it, `module.app[0]`. The node id then
   * carries the key on the scope's segment, `estate/module.app[0]/aws_eip.pool[1]`.
   */
  instanceScope?: string;
}

/**
 * What an edge means (#3910). `ref` is a typed cross-resource reference (an
 * `AttrRef`, a `Ref` intrinsic, a whole node held in props, or an
 * {@link EntityReference}). The rest are the dependency strings a CI lexicon
 * writes, reported through a plugin's `graphEdges` hook:
 *
 *  - `needs`    — job waits for job (GitHub/GitLab `needs:`, GitLab stage order)
 *  - `calls`    — job runs a reusable workflow or a local composite action (`uses:`)
 *  - `triggers` — a pipeline starts another one: GitLab `trigger:` (from starts to),
 *                 GitHub `on.workflow_run` (to finishing starts from)
 *  - `includes` — a pipeline pulls in another file's config (GitLab `include:`)
 *  - `extends`  — a job inherits another job's keys (GitLab `extends:`)
 *
 * Every edge points from the entity that holds the reference to the entity it
 * names. The set grows additively ({@link GRAPH_IR_VERSION}): a reader ignores
 * a kind it does not know.
 */
export type IREdgeKind = "ref" | "needs" | "calls" | "triggers" | "includes" | "extends";

/** A directed dependency: `from` references `to` (an attribute of it, for `ref`). */
export interface IREdge {
  from: string;
  to: string;
  /** "ref" for an AttrRef-derived edge; a CI kind otherwise (see {@link IREdgeKind}). */
  kind: IREdgeKind;
  /** The consumer-side property the reference flows through, when derivable. */
  viaAttr?: string;
  /** The producer-side attribute referenced (e.g. "id"). Added at detail T3. */
  toAttr?: string;
  /**
   * True when the edge leaves the pipeline `from` belongs to (#3910): a
   * reusable-workflow call, a `workflow_run` trigger, a GitLab child or
   * multi-project trigger, an include, a cross-project `needs`. A renderer
   * that draws each pipeline as a group ({@link IRGroups.byPipeline}) reads
   * this to route the edge between groups. Absent on every in-pipeline edge.
   */
  crossPipeline?: boolean;
}

/**
 * A reference whose target is not a node of this graph (#3910): a job
 * `needs` a job no workflow declares, a `uses:` names another repository's
 * workflow, a GitLab `include:` names a file chant did not generate. Kept on
 * the IR rather than dropped or matched to a near name, so a reader can tell
 * "no dependency" from "a dependency on something outside this project".
 * Field names follow the live resolver's `DanglingRef` (./graph-refs.ts).
 */
export interface IRDanglingRef {
  /** The node holding the reference. */
  from: string;
  /** The edge kind the reference would have been. */
  kind: IREdgeKind;
  /** Where on `from` it was written, e.g. `needs`, `uses`, `trigger.include`. */
  path: string;
  /** The reference exactly as written. */
  value: string;
  /** Same meaning as {@link IREdge.crossPipeline}. */
  crossPipeline?: boolean;
}

/**
 * One reference a lexicon reports through its `graphEdges` hook (#3910),
 * resolved by the lexicon from strings core cannot read: job names, workflow
 * file paths, pipeline names. `from` and `to` are entity keys. A reference
 * the lexicon could not resolve sets `dangling` and carries the string as
 * written in `to`; core turns it into an {@link IRDanglingRef}.
 */
export interface LexiconGraphReference {
  from: string;
  to: string;
  kind: IREdgeKind;
  viaAttr?: string;
  crossPipeline?: boolean;
  dangling?: boolean;
}

/**
 * One output a lexicon reports for its own declarations (#3931): a name a
 * workspace link may target, such as a sql table's `public.orders` or a
 * column's `public.orders.customer_id`.
 */
export interface LexiconWorkspaceOutput {
  /** The output's name, as a link's `output` names it. */
  name: string;
  /** The entity key that declares it. */
  entity: string;
  /**
   * Names the output had before, from a rename hint in source (a sql
   * `-- previously:` comment). A link to one of them is told where it went.
   */
  previously?: string[];
}

/** One file the reader was handed but could not read without running it (#3931). */
export interface LexiconUnreadSource {
  /** The file's path, as the caller names it in messages. */
  file: string;
  text: string;
  /** Why it was not read: the fold's located reason. */
  reason: string;
}

/** What a lexicon's `workspaceOutputs` hook returns (#3931). */
export interface LexiconWorkspaceOutputs {
  outputs: LexiconWorkspaceOutput[];
  /**
   * Why the list may be incomplete, one line each: a declaration whose name
   * can't be known statically, a file of this lexicon's that did not fold, a
   * view whose columns can't be derived. Empty or absent when it is complete.
   */
  gaps?: string[];
}

/**
 * One link a lexicon reads from its own declarations (#4397): an output of
 * another member that a declaration depends on, such as a table an otel
 * `clickhouse` exporter writes.
 */
export interface LexiconWorkspaceLink {
  /** The producer's output the declaration reads or writes: `default.otel_logs`, `default.otel_logs.Body`. */
  output: string;
  /**
   * The output that picks the producer when `member` is unset; unset, the
   * output itself. A column is anchored on its table, so a dropped column is
   * missing from the member that still has the table.
   */
  anchor?: string;
  /** The producer, when the declaration names it. Unset, the one member exposing `anchor`. */
  member?: string;
  /** The entity key that states the link, for the finding's file and line. */
  entity: string;
}

/** What a lexicon's `workspaceLinks` hook returns (#4397). */
export interface LexiconWorkspaceLinks {
  links: LexiconWorkspaceLink[];
  /** Places the hook could not read without the environment, one line each. Their links are left out. */
  gaps?: string[];
}

/** What a lexicon's `graphEdges` hook returns (#3910). */
export interface LexiconGraphEdges {
  references: LexiconGraphReference[];
  /**
   * Pipeline membership, `pipeline name -> entity keys`: a workflow and its
   * jobs, a GitLab pipeline and its jobs. Lands on {@link IRGroups.byPipeline}.
   */
  pipelines?: Record<string, string[]>;
}

/**
 * One reference an entity declares in a vocabulary this module cannot read
 * (#2265), already resolved to the entity key it points at.
 *
 * `collectEdges` below finds references two ways: an {@link AttrRef} object a
 * typed lexicon puts in its props, and a `Ref`-shaped intrinsic. Both are
 * objects with a resolvable target, which is what makes them findable by a
 * walk that knows no lexicon. A lexicon that PARSES someone else's source has
 * neither: the terraform lexicon's entities keep their block body verbatim
 * from hcl2json, where a reference to another block is the string
 * `"${aws_vpc.main.id}"` and nothing else. The walk finds nothing, correctly,
 * and a 247-node estate graphs with zero edges.
 *
 * The reference is not missing, it is just in the producer's vocabulary, and
 * resolving it needs an HCL expression parser and the lexicon's own key shape.
 * So the lexicon resolves it and says so here, on the entity, in the one
 * vocabulary this module does understand: an entity key, plus the two
 * attribute names {@link IREdge} already carries.
 *
 * The hook is a plain duck-typed optional field any entity MAY carry beside
 * its `props`, read through {@link entityReferences}. That is the same shape
 * (and the same reasoning) as `suppressions`, ../lint/suppressions.ts: a
 * reference is a fact ABOUT one entity, `Declarable` already lets each lexicon
 * carry its own fields beside `props`, and nothing that constructs or merges
 * an entity map had to change for it. A lexicon that wants edges adopts the
 * convention on its own entities; every other lexicon keeps the AttrRef walk
 * it already had, and the two sources of edges merge in one place.
 *
 * An entry whose `to` is not a node in this graph is dropped rather than kept
 * as a dangling endpoint, the same rule {@link buildLiveGraphIr} applies to an
 * observed edge.
 */
export interface EntityReference {
  /** The referenced entity's key, in the same space as the IR's node ids. */
  to: string;
  /** The consumer-side attribute the reference flows through (`IREdge.viaAttr`). */
  viaAttr?: string;
  /** The producer-side attribute referenced (`IREdge.toAttr`), when the reference named exactly one. */
  toAttr?: string;
}

/** True when `value` has the {@link EntityReference} shape. */
function isEntityReference(value: unknown): value is EntityReference {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { to?: unknown }).to === "string"
  );
}

/**
 * The references an entity declared for itself (#2265), or an empty list.
 * Duck-typed on purpose, see {@link EntityReference}.
 */
export function entityReferences(entity: Declarable): readonly EntityReference[] {
  const declared = (entity as unknown as { references?: unknown }).references;
  if (!Array.isArray(declared)) return [];
  return declared.filter(isEntityReference);
}

/**
 * The deployable unit an entity says it belongs to (#2266), or undefined.
 *
 * Same duck-typed channel as {@link entityReferences}, for the other half of
 * the same problem. `groups.byStack` keys by lexicon partition when nothing
 * says otherwise, on the reasoning that one lexicon serialises to one
 * deployable stack. That reasoning is exactly wrong for a lexicon reading an
 * estate that already has several: a terraform project declaring five
 * `terraform.roots` has five things `terraform apply` runs against, and each
 * one is a stack in every sense `byStack` means, so five roots landed in one
 * bucket named `terraform`.
 *
 * The root is not inferable here and should not be: it is the producer's own
 * name for its own unit. A consumer could recover it from the node id prefix
 * the terraform lexicon mints, but an id convention is not a promise, and
 * `byStack` is the field whose whole job is saying which box a node goes in.
 */
export function entityStack(entity: Declarable): string | undefined {
  const stack = (entity as unknown as { stack?: unknown }).stack;
  return typeof stack === "string" && stack.length > 0 ? stack : undefined;
}

/**
 * The instance keys an entity says its source expands to (#4454), as the
 * engine prints them (`[0]`, `["a"]`), or an empty list. Duck-typed like
 * {@link entityStack}: the terraform lexicon sets `instanceKeys` on a block
 * whose `count` or `for_each` is a literal.
 */
export function entityInstanceKeys(entity: Declarable): readonly string[] {
  const keys = (entity as unknown as { instanceKeys?: unknown }).instanceKeys;
  if (!Array.isArray(keys)) return [];
  return keys.filter((k): k is string => typeof k === "string" && k.startsWith("[") && k.endsWith("]"));
}

/** One instance node an entity names (#4486): its full id, and the key and scope it carries. */
export interface EntityInstance {
  id: string;
  key?: string;
  scope?: string;
}

/**
 * The instance nodes an entity names, given its own key `name`: the
 * duck-typed `instances` list when it carries one (full ids, which an
 * instance under an expanded module call needs, #4486), else one per
 * {@link entityInstanceKeys} key, id `<name><key>`.
 */
export function entityInstances(name: string, entity: Declarable): EntityInstance[] {
  const listed = (entity as unknown as { instances?: unknown }).instances;
  if (Array.isArray(listed)) {
    const out: EntityInstance[] = [];
    for (const item of listed) {
      if (typeof item !== "object" || item === null) continue;
      const { id, key, scope } = item as { id?: unknown; key?: unknown; scope?: unknown };
      if (typeof id !== "string" || id.length === 0 || id === name) continue;
      out.push({ id, ...(typeof key === "string" ? { key } : {}), ...(typeof scope === "string" ? { scope } : {}) });
    }
    return out;
  }
  return entityInstanceKeys(entity).map((key) => ({ id: `${name}${key}`, key }));
}

/** Grouping metadata for cluster/subgraph rendering. Maps group name -> node ids. */
export interface IRGroups {
  byLexicon?: Record<string, string[]>;
  byComposite?: Record<string, string[]>;
  /**
   * Deployable-stack grouping (`stackName → nodeIds`). Consumers (e.g. pinhole's
   * boundary boxes) read this rather than inferring stacks — which is the point,
   * so it should never require one.
   *
   * Three sources, depending on how the project is shaped:
   *
   *  - **side-by-side stacks**, declared in config and composed by
   *    `buildDeclaredPerStack` — keys are the declared stack names. Nothing is
   *    inferred; the project stated both the names and the membership.
   *  - **entities that name their own unit** ({@link entityStack}, #2266) —
   *    keys are those names, one entry per unit. A terraform root is the case
   *    this exists for: five `terraform.roots` are five `terraform apply`s and
   *    five boundary boxes, not one bucket called `terraform`.
   *  - **one source tree** — keys are lexicon partitions, since each lexicon
   *    serialises to one deployable stack.
   *
   * Formerly documented as awaiting "#513 phase 2" to regroup by nested
   * child-project. #513 is closed and that phase was never filed; directory
   * partitioning is the exception rather than the rule (#1433).
   */
  byStack?: Record<string, string[]>;
  /** Live containment (#779): a container node id → the node ids directly inside
   * it (VPC → subnets/SGs, subnet → instances/service). Nested *flatly* — a
   * subnet is both a member of its VPC's entry and a key with its own members —
   * so a boundary-box renderer recurses it. Populated by `chant graph --live`
   * from the reference resolver's containment output; absent for source IR. */
  byContainer?: Record<string, string[]>;
  /** Component-graph deploy wave (`chant graph --components --format ir`):
   * `wave-N → component node ids` that deploy in parallel in that wave. A
   * wave-laned renderer reads this the way `byStack` drives boundary boxes.
   * Present only for the component-DAG projection; absent for entity IR. */
  byWave?: Record<string, string[]>;
  /** CI pipeline membership (#3910): a workflow or pipeline name -> the node
   * ids it runs (the workflow node and its jobs). Reported by a CI lexicon's
   * `graphEdges` hook; absent when no lexicon reports one. Edges marked
   * `crossPipeline` run between these groups. */
  byPipeline?: Record<string, string[]>;
}

/** A cross-stack export this stack publishes (a `stackOutput`/`output`): its
 * name (the matching key another stack imports by) and the node that produces it. */
export interface IRExport {
  /** Output name — the cross-stack handle (e.g. "ClusterArn"). */
  name: string;
  /** Logical name of the producing node, when resolvable. */
  node?: string;
  /** Producer-side attribute the output reads (e.g. "Arn"). */
  attr?: string;
  /** The published value, when the graph was observed rather than declared (#1279). */
  value?: unknown;
  /** The deployed stack that publishes it, on an observed graph (#1279). */
  stack?: string;
  /** Names the output had before, from a rename hint a lexicon read (#3931). */
  previously?: string[];
}

/** A cross-stack import this stack consumes — a `Parameter` fed from another
 * stack's output at deploy time. A viewer matches an import `name` to another
 * stack's export `name` to draw the cross-stack edge; the parameter's in-stack
 * consumers are ordinary `$ref` edges to `node` (#513). A reader that infers
 * that match by name uses `joinKey()` from `./join-key.ts` and labels the edge
 * `exact` or `folded`, the way `chant workspace graph` labels joins across
 * members (#2539, ws-008). */
export interface IRImport {
  /** Parameter name — the cross-stack handle (e.g. "clusterArn"). */
  name: string;
  /** Logical name of the parameter node. */
  node: string;
}

/**
 * One generated CI job in the pipeline projection (`chant graph --components
 * --format ir --projection <lexicon>`, #989) — the same job a CI-provider
 * lexicon's `generateComponentPipeline` synthesizes for `chant build
 * --components --generate <lexicon>` (see `ComponentPipelineJob`,
 * ./lexicon.ts), reshaped into the IR's node vocabulary.
 */
export interface IRPipelineNode {
  /** CI job name (the generator's job id — a safe YAML/workflow key). */
  id: string;
  kind: "CIJob";
  /** The component this job triggers. */
  component: string;
  /** The stage/wave this job runs in — the same wave index as the component
   * graph's `groups.byWave` (one CI stage/`needs:`-level per wave). */
  stage: string;
}

/** A `needs:` dependency between two generated CI jobs — mirrors the
 * `dependsOn` edge it derives from, consumer job → producer job. */
export interface IRPipelineEdge {
  from: string;
  to: string;
  kind: "needs";
}

/**
 * The CI/pipeline projection of a component graph (#989): the stages/jobs/
 * `needs` a CI-provider lexicon (gitlab, github, forgejo, or any lexicon
 * implementing `generateComponentPipeline`) would synthesize for `chant build
 * --components --generate <lexicon>`, reused here — never re-derived — as
 * first-class IR nodes/edges. A consumer (e.g. behold) reads this alongside
 * the component graph's `nodes`/`edges`/`groups.byWave` to render the CI
 * shape without parsing generated YAML. Present only when `chant graph
 * --components --format ir` is invoked with `--projection <lexicon>`.
 */
export interface IRPipeline {
  /** The CI-provider lexicon that produced this projection (e.g. "gitlab"). */
  provider: string;
  /**
   * The environment the projected pipeline deploys (#2046) — copied from the
   * generator's own resolution (`ComponentPipelineResult.env`), so the IR
   * carries the identity instead of leaving a consumer to lex it out of a
   * job's run line.
   */
  env?: string;
  /** Wave-ordered stage names — 1:1 with the component graph's `groups.byWave` keys. */
  stages: string[];
  nodes: IRPipelineNode[];
  edges: IRPipelineEdge[];
}

/**
 * The version `chant graph --format ir` writes on its output (#2529, #2524 D8).
 * The format changes only additively: a new field or edge kind never bumps
 * it, and a consumer ignores the fields and edge kinds it does not know. The
 * number moves only for a change a consumer could not ignore.
 */
export const GRAPH_IR_VERSION = 1;

/** The full graph IR for a project at the default (declarable) detail level. */
export interface GraphIR {
  /**
   * {@link GRAPH_IR_VERSION}, stamped by `chant graph --format ir` when it
   * writes the IR (#2529). Absent on an IR built in memory, and on output
   * from a chant older than the field, which a reader treats as version 1.
   */
  version?: number;
  nodes: IRNode[];
  edges: IREdge[];
  groups: IRGroups;
  /**
   * Graph-level facts that are about the whole read rather than any one node.
   *
   * Deliberately an open bag. A fact lands here when it has no node to sit on
   * — `_behaviour` (#2377) carries the engine, its version, the traffic level
   * the figures are *at*, and the estate's totals, or a whole refusal report
   * when there was no engine to ask. None of that is a property of a single
   * entity, and putting the refusal on nodes would mean writing it N times or
   * dropping it, and dropping it is the one outcome the contract forbids
   * (`./behaviour-overlay.ts`).
   *
   * Absent unless something filled it, and a consumer reads absence as "not
   * looked" rather than as a negative finding.
   */
  meta?: Record<string, unknown>;
  /** Outputs this stack publishes for other stacks to import (#513). */
  exports?: IRExport[];
  /** Parameters this stack imports from other stacks. A viewer matches an import's
   * `name` to another stack's export `name` to draw the cross-stack edge; the
   * parameter's in-stack consumers are ordinary `$ref` edges to it (#513). */
  imports?: IRImport[];
  /** The CI/pipeline projection alongside the component graph (#989) — see {@link IRPipeline}. */
  pipeline?: IRPipeline;
  /**
   * References that name nothing in this graph (#3910) — see
   * {@link IRDanglingRef}. Absent when there are none.
   */
  dangling?: IRDanglingRef[];
  /**
   * Attributes chant computed rather than read back from the provider, keyed by the kind
   * they were folded onto. An enrichment pass records what it derived here so callers can
   * report the graph's own surface without knowing any attribute name — the set is whatever
   * the passes produced, not a list maintained by hand.
   */
  derivedAttrs?: Record<string, string[]>;
  /**
   * With `chant graph --format ir --capability-view` (#4378): the
   * lexicon-neutral view capability rules read, built by this chant through
   * the project's own lexicon mappings and adapters. A `ViewDocument`
   * (`capabilities/view.ts`). Absent unless asked for.
   */
  capabilityView?: unknown;
  /**
   * With `chant graph --live` (INTENTIUS/chant#4452): which read answered each
   * root, the observation's structured {@link RootRead} report passed through
   * as the lexicon wrote it, keyed by the lexicon's root key (terraform uses
   * `terraform.roots.<root>`). `depth` is the read asked for, and `fellBackTo`
   * and `reason` are set only when that read failed, so the read that answered
   * is `fellBackTo ?? depth`. A consumer reads this and never the stderr notes
   * that say the same thing in prose. Additive: absent when no lexicon reported
   * one (a lexicon with one read path, a source graph, an `--at` replay), and
   * an older chant never writes it.
   */
  rootReads?: Record<string, RootRead>;
}

/** A node is anything that serializes to a resource — not a property or output. */
function isNodeEntity(entity: Declarable): boolean {
  if (isLexiconOutput(entity)) return false;
  if (entity.kind === "property") return false;
  return true;
}

function relFile(file: string | undefined, projectPath?: string): string | undefined {
  if (!file) return undefined;
  if (projectPath && isAbsolute(file)) {
    const rel = relative(projectPath, file);
    return rel.startsWith("..") ? file : rel;
  }
  return file;
}

/** The logical name a `Ref`-style intrinsic points at, or undefined. Lexicon-
 * agnostic: reads the intrinsic's `toJSON()` for the CloudFormation `{ Ref: name }`
 * shape (aws `RefIntrinsic` etc.). A `Ref` to a node is a real dependency edge,
 * not an opaque intrinsic (#513) — so we resolve it rather than flatten it. */
function refIntrinsicTarget(value: unknown): string | undefined {
  try {
    const json = (value as { toJSON?: () => unknown }).toJSON?.();
    if (json && typeof json === "object" && typeof (json as { Ref?: unknown }).Ref === "string") {
      return (json as { Ref: string }).Ref;
    }
  } catch {
    // Unresolvable at graph-build time — leave it as an opaque intrinsic.
  }
  return undefined;
}

/** A CloudFormation `Fn::Sub`: its template, and the variable map of the two-argument form. */
interface SubForm {
  template: string;
  vars?: Record<string, unknown>;
}

/** Read `{ "Fn::Sub": "..." }` or `{ "Fn::Sub": ["...", { ... }] }`, or undefined. */
function subForm(json: unknown): SubForm | undefined {
  if (json === null || typeof json !== "object" || Array.isArray(json)) return undefined;
  const keys = Object.keys(json);
  if (keys.length !== 1 || keys[0] !== "Fn::Sub") return undefined;
  const arg = (json as Record<string, unknown>)["Fn::Sub"];
  if (typeof arg === "string") return { template: arg };
  if (Array.isArray(arg) && typeof arg[0] === "string") {
    const vars = arg[1];
    return vars !== null && typeof vars === "object" && !Array.isArray(vars)
      ? { template: arg[0], vars: vars as Record<string, unknown> }
      : { template: arg[0] };
  }
  return undefined;
}

/** The `Fn::Sub` an intrinsic serializes to (the aws `Sub` tag), or undefined. */
function subIntrinsicForm(value: unknown): SubForm | undefined {
  try {
    return subForm((value as { toJSON?: () => unknown }).toJSON?.());
  } catch {
    // An AttrRef inside whose logical name is not set yet: no template to read.
    return undefined;
  }
}

/** False when an intrinsic's `toJSON()` throws (an AttrRef inside it has no logical name yet). */
function serializes(value: unknown): boolean {
  try {
    (value as { toJSON?: () => unknown }).toJSON?.();
    return true;
  } catch {
    return false;
  }
}

/**
 * The logical names serialized CloudFormation JSON references: `{ Ref }`,
 * `{ "Fn::GetAtt" }` in either encoding, and a nested `Fn::Sub`. Reads a
 * two-argument `Sub`'s variable map after `toJSON()` has turned its live
 * references into JSON.
 */
function cfnJsonRefNames(json: unknown, out: string[]): void {
  if (json === null || typeof json !== "object") return;
  if (Array.isArray(json)) {
    for (const item of json) cfnJsonRefNames(item, out);
    return;
  }
  const obj = json as Record<string, unknown>;
  if (typeof obj.Ref === "string") {
    out.push(obj.Ref);
    return;
  }
  const getAtt = obj["Fn::GetAtt"];
  if (getAtt !== undefined) {
    const id = Array.isArray(getAtt) ? getAtt[0] : typeof getAtt === "string" ? getAtt.split(".")[0] : undefined;
    if (typeof id === "string") out.push(id);
    return;
  }
  const sub = subForm(obj);
  if (sub) {
    for (const r of subTemplateRefs(sub.template, new Set(Object.keys(sub.vars ?? {})))) out.push(r.name);
    if (sub.vars) cfnJsonRefNames(Object.values(sub.vars), out);
    return;
  }
  for (const v of Object.values(obj)) cfnJsonRefNames(v, out);
}

/** Resolve the producer (logical name) an AttrRef points at. */
function refTarget(ref: AttrRef, reverse: Map<object, string>): string | undefined {
  // Nested refs (under `props`) aren't assigned a logical name by resolveAttrRefs,
  // which only resolves top-level own props — so fall back to the parent's name.
  const parent = ref.parent.deref();
  return ref.getLogicalName() ?? (parent ? reverse.get(parent) : undefined);
}

/**
 * The node id a whole declarable held in a config bag stands for, or undefined
 * when it is not a node of this graph (an inlined property-kind resource, say,
 * which is config of the holder and gets walked instead). An entity can name
 * another entity directly rather than through an AttrRef, as the sql lexicon's
 * enumerable `dependsOn` does with the tables, views and databases a statement
 * mentions (#3257); that is a reference to the node, not a nested bag.
 */
function nodeReference(
  value: unknown,
  reverse: Map<object, string>,
  nodeIds: Set<string>,
): string | undefined {
  const id = reverse.get(value as object);
  return id !== undefined && nodeIds.has(id) ? id : undefined;
}

/** Project a value into a JSON-safe, scrubbed form. References become `{ $ref }`. */
function project(value: unknown, seen: Set<unknown>, reverse: Map<object, string>, nodeIds: Set<string>): unknown {
  if (value === null) return null;
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return value;
  if (t !== "object") return undefined; // functions, symbols, undefined

  // Duck-type, not `instanceof`: a lexicon built against a different copy of
  // `@intentius/chant` produces AttrRefs that fail `instanceof AttrRef` but carry
  // the same shape. Without this, a real cross-resource reference falls through to
  // the intrinsic branch below and is silently flattened to `{$intrinsic}` (#511).
  if (isAttrRefLike(value)) {
    const to = refTarget(value, reverse);
    return { $ref: to ? `${to}.${value.attribute}` : value.attribute } satisfies AttrRefEnvelope;
  }
  if ((value as Record<symbol, unknown>)[INTRINSIC_MARKER] === true) {
    // A `Ref` to a known node is a real reference — surface it as `$ref` so attrs
    // match the edge (#513). Other intrinsics (interpolations, pseudo-parameters,
    // Ref to a non-node) stay opaque.
    const to = refIntrinsicTarget(value);
    if (to && nodeIds.has(to)) return { $ref: to } satisfies AttrRefEnvelope;
    // A Sub keeps its template, so a reader sees which node and attribute it names (#4373).
    const sub = subIntrinsicForm(value);
    if (sub) return subEnvelope(sub, seen, reverse, nodeIds);
    return { $intrinsic: true };
  }

  if (seen.has(value)) return undefined; // break cycles
  seen.add(value);

  // Nested declarables (e.g. an inlined property-kind resource) keep their
  // config in a non-enumerable `props` bag, like top-level nodes — project that.
  if (isDeclarable(value)) {
    // Another node held whole is a reference to it, not config to inline.
    const to = nodeReference(value, reverse, nodeIds);
    if (to) return { $ref: to } satisfies AttrRefEnvelope;
    const out = projectConfig(value, seen, reverse, nodeIds);
    seen.delete(value);
    return out;
  }

  if (Array.isArray(value)) {
    const out = value.map((v) => project(v, seen, reverse, nodeIds)).filter((v) => v !== undefined);
    seen.delete(value);
    return out;
  }

  // A Sub written as plain CloudFormation JSON reads the same as the `Sub` tag's.
  const plainSub = subForm(value);
  if (plainSub) {
    const out = subEnvelope(plainSub, seen, reverse, nodeIds);
    seen.delete(value);
    return out;
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const p = project(v, seen, reverse, nodeIds);
    if (p !== undefined) out[k] = p;
  }
  seen.delete(value);
  return out;
}

/** Project a {@link SubForm} into its {@link SubEnvelope}. */
function subEnvelope(sub: SubForm, seen: Set<unknown>, reverse: Map<object, string>, nodeIds: Set<string>): SubEnvelope {
  if (!sub.vars) return { $sub: sub.template };
  const vars: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(sub.vars)) {
    const p = project(v, seen, reverse, nodeIds);
    if (p !== undefined) vars[k] = p;
  }
  return { $sub: sub.template, $vars: vars };
}

// `references` and `stack` are the two duck-typed channels above
// ({@link entityReferences}, {@link entityStack}). They are metadata about the
// entity's place in the graph, not declared configuration, and both are read
// directly, so projecting them into `attrs` would only restate an edge and a
// group key the IR already carries.
const SKIP_KEYS = new Set(["lexicon", "entityType", "kind", "attributes", "Ref", "references", "stack"]);

/** The config bag of a node, paired with each key. Lexicon entities keep their
 * declared props in a (usually non-enumerable) `props` object; simpler entities
 * carry config as enumerable own properties. We surface both, flattening `props`
 * so a field reads as e.g. `network`, not `props.network`. */
function configRoots(entity: Declarable): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [];
  for (const [k, v] of Object.entries(entity)) {
    if (SKIP_KEYS.has(k) || k === "props") continue;
    out.push([k, v]);
  }
  const props = (entity as unknown as { props?: unknown }).props;
  if (props && typeof props === "object" && !Array.isArray(props)) {
    for (const [k, v] of Object.entries(props as Record<string, unknown>)) out.push([k, v]);
  }
  return out;
}

/** Project a declarable's config bag (flattened props + enumerable own props). */
function projectConfig(
  entity: Declarable,
  seen: Set<unknown>,
  reverse: Map<object, string>,
  nodeIds: Set<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of configRoots(entity)) {
    const p = project(v, seen, reverse, nodeIds);
    if (p !== undefined) out[k] = p;
  }
  return out;
}

/**
 * Collect ref edges from one node, labelling each with its consumer property.
 *
 * Two sources, merged here. First the references the entity resolved for
 * itself ({@link EntityReference}), which is how a lexicon that parses HCL,
 * YAML or any other foreign source says what its strings point at. Then the
 * walk over the config bag for {@link AttrRef} objects and `Ref` intrinsics,
 * which is how a typed lexicon's props carry the same fact. A lexicon uses one
 * or the other; nothing stops it using both, and the dedup in `buildGraphIr`
 * collapses an edge two sources agree on.
 */
function collectEdges(
  entity: Declarable,
  from: string,
  nodeIds: Set<string>,
  reverse: Map<object, string>,
): IREdge[] {
  const edges: IREdge[] = [];
  for (const ref of entityReferences(entity)) {
    if (ref.to === from || !nodeIds.has(ref.to)) continue;
    edges.push({
      from,
      to: ref.to,
      kind: "ref",
      ...(ref.viaAttr ? { viaAttr: ref.viaAttr } : {}),
      ...(ref.toAttr ? { toAttr: ref.toAttr } : {}),
    });
  }
  const seen = new Set<unknown>();
  const edgeTo = (to: string, viaAttr: string): void => {
    if (to !== from && nodeIds.has(to)) edges.push({ from, to, kind: "ref", viaAttr });
  };
  const visit = (value: unknown, viaAttr: string): void => {
    if (value === null || typeof value !== "object") return;
    if (isAttrRefLike(value)) {
      const to = refTarget(value, reverse);
      if (to && to !== from && nodeIds.has(to)) {
        edges.push({ from, to, kind: "ref", viaAttr });
      }
      return;
    }
    if ((value as Record<symbol, unknown>)[INTRINSIC_MARKER] === true) {
      // A `Ref` to a known node (a Parameter, or a resource) is a real dependency
      // — resolve it to an edge instead of dropping it as an opaque intrinsic (#513).
      const to = refIntrinsicTarget(value);
      if (to && to !== from && nodeIds.has(to)) edges.push({ from, to, kind: "ref", viaAttr });
      // A Sub's interpolations are references too (#4373): each `${Name}` or
      // `${Name.Attr}` naming a node, and each reference in a variable map.
      const sub = subIntrinsicForm(value);
      if (sub) {
        const names = subTemplateRefs(sub.template, new Set(Object.keys(sub.vars ?? {}))).map((r) => r.name);
        if (sub.vars) cfnJsonRefNames(Object.values(sub.vars), names);
        for (const name of names) edgeTo(name, viaAttr);
      }
      // The live values the aws `Sub` tag interpolated. Covers an AttrRef whose
      // logical name was not set, where `toJSON()` throws and leaves no
      // template to read above. Any other intrinsic stays opaque.
      const interpolated = (value as { values?: unknown }).values;
      if (Array.isArray(interpolated) && (sub || !serializes(value))) {
        for (const v of interpolated) visit(v, viaAttr);
      }
      return;
    }
    // A Sub written as plain CloudFormation JSON in props: the template's names
    // here, then the variable map's live values through the walk below.
    const plainSub = subForm(value);
    if (plainSub) {
      for (const r of subTemplateRefs(plainSub.template, new Set(Object.keys(plainSub.vars ?? {})))) {
        edgeTo(r.name, viaAttr);
      }
    }
    // A whole node held in props or an enumerable field (the sql lexicon's
    // `dependsOn`) is a reference to it: draw the edge, and do not walk its
    // config, whose refs belong to that node's own edges (#3257). Checked
    // before `seen` so the same node under two attributes yields both edges.
    const held = nodeReference(value, reverse, nodeIds);
    if (held) {
      if (held !== from) edges.push({ from, to: held, kind: "ref", viaAttr });
      return;
    }
    if (seen.has(value)) return;
    seen.add(value);
    // A nested declarable (an inlined property-kind resource, e.g. a listener's
    // `DefaultActions: [Listener_Action{ TargetGroupArn: tg.TargetGroupArn }]`)
    // keeps its config in a NON-enumerable `props` bag, so `Object.values`
    // below would walk right past the ref inside it and drop the edge. Descend
    // via `configRoots` (which reads `props`), mirroring `project`'s handling —
    // the ref then resolves to a real from→to edge on the containing node.
    if (isDeclarable(value)) {
      for (const [, v] of configRoots(value)) visit(v, viaAttr);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, viaAttr);
      return;
    }
    for (const v of Object.values(value as Record<string, unknown>)) visit(v, viaAttr);
  };
  for (const [k, v] of configRoots(entity)) visit(v, k);
  return edges;
}

/** Stable key for deduping and sorting an edge. */
function edgeKey(e: IREdge): string {
  return `${e.from}\0${e.to}\0${e.viaAttr ?? ""}`;
}

/**
 * Build the graph IR from resolved entities (the output of `discover`). Pure and
 * deterministic: nodes and edges are sorted, so the same source yields identical
 * IR. `projectPath` relativizes source-file paths for portable output.
 */
export function buildGraphIr(
  entities: Map<string, Declarable>,
  projectPath?: string,
): GraphIR {
  // Reverse lookup for producers whose AttrRef logical name wasn't resolved.
  const reverse = new Map<object, string>();
  for (const [name, entity] of entities) reverse.set(entity, name);

  const nodeIds = new Set<string>();
  for (const [name, entity] of entities) {
    if (isNodeEntity(entity)) nodeIds.add(name);
  }

  const nodes: IRNode[] = [];
  const byLexicon: Record<string, string[]> = {};
  const byComposite: Record<string, string[]> = {};
  const byStack: Record<string, string[]> = {};

  for (const [name, entity] of entities) {
    if (!nodeIds.has(name)) continue;
    const prov = getProvenance(entity);
    const node: IRNode = {
      id: name,
      kind: entity.entityType,
      lexicon: entity.lexicon,
      attrs: projectConfig(entity, new Set(), reverse, nodeIds),
    };
    if (prov?.composite) node.compositeParent = prov.composite;
    if (prov?.compositeInstance) node.compositeInstance = prov.compositeInstance;
    const file = relFile(prov?.sourceFile, projectPath);
    if (file) node.sourceLoc = { file };
    nodes.push(node);

    (byLexicon[entity.lexicon] ??= []).push(name);
    // An entity that names its own deployable unit is taken at its word
    // (#2266): a terraform root is one `terraform apply`, and a project
    // declaring five of them has five stacks whatever the lexicon count says.
    // See {@link entityStack}.
    //
    // Otherwise, within ONE source tree a stack is a lexicon partition — each
    // lexicon serialises to one deployable stack (a CloudFormation template, a
    // CI config) — so that is what `byStack` reports. It stays a distinct axis
    // from `byLexicon` (which is for provenance/colouring), emitted separately
    // even where the two coincide.
    //
    // A project with genuinely separate, side-by-side stacks declares them in
    // config, and `buildDeclaredPerStack` (./graph-declared.ts) groups those by
    // their declared names — no inference, since the project already said. That
    // is the multi-stack shape chant steers toward (#1433).
    //
    // This previously promised that "#513 phase 2 will regroup it by nested
    // child-project". #513 is closed, that phase was never filed, and directory
    // partitioning is the exception rather than the rule — so the promise is
    // withdrawn rather than left pointing at a closed issue.
    (byStack[entityStack(entity) ?? entity.lexicon] ??= []).push(name);
    if (prov?.composite) (byComposite[prov.composite] ??= []).push(name);
  }

  const edgeMap = new Map<string, IREdge>();
  for (const [name, entity] of entities) {
    if (!nodeIds.has(name)) continue;
    for (const e of collectEdges(entity, name, nodeIds, reverse)) {
      edgeMap.set(edgeKey(e), e);
    }
  }

  nodes.sort((a, b) => a.id.localeCompare(b.id));
  const edges = [...edgeMap.values()].sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)));
  for (const ids of Object.values(byLexicon)) ids.sort();
  for (const ids of Object.values(byComposite)) ids.sort();
  for (const ids of Object.values(byStack)) ids.sort();

  const groups: IRGroups = {};
  if (Object.keys(byLexicon).length) groups.byLexicon = sortKeys(byLexicon);
  if (Object.keys(byComposite).length) groups.byComposite = sortKeys(byComposite);
  if (Object.keys(byStack).length) groups.byStack = sortKeys(byStack);

  // Cross-stack exports: a stack's `output(ref, name)` LexiconOutputs are dropped
  // from the node set (they're not resources), but their name + producing node is
  // the handle another stack imports by. Surface them so a viewer can draw the
  // cross-stack edge (#513). Resolve the producer via the output's source entity.
  const exports: IRExport[] = [];
  for (const entity of entities.values()) {
    if (!isLexiconOutput(entity)) continue;
    const lo = entity as unknown as LexiconOutput;
    if (!lo.outputName) continue;
    const parent = lo._sourceParent?.deref();
    const node = (parent ? reverse.get(parent) : undefined) ?? (lo.sourceEntity || undefined);
    exports.push({ name: lo.outputName, ...(node ? { node } : {}), ...(lo.sourceAttribute ? { attr: lo.sourceAttribute } : {}) });
  }
  exports.sort((a, b) => a.name.localeCompare(b.name));

  // Cross-stack imports: parameter nodes are the handles this stack imports by,
  // matched to another stack's export names (#513). Detected by kind — the aws
  // `Parameter` is the cross-stack input mechanism.
  const imports: IRImport[] = nodes
    .filter((n) => /(^|::)Parameter$/i.test(n.kind))
    .map((n) => ({ name: n.id, node: n.id }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const ir: GraphIR = { nodes, edges, groups };
  if (exports.length) ir.exports = exports;
  if (imports.length) ir.imports = imports;
  return ir;
}

/**
 * Add an instance node (#4454) under each node whose entity names its
 * instances ({@link entityInstances}): id `<block id><key>`, or the full id
 * the entity lists under an expanded module call (#4486), the
 * block's kind, lexicon and source location, `instanceOf` and `instanceKey`,
 * no attrs and no edges. Each instance joins every group its block is in, so
 * a renderer draws it in the block's box. Pure. Returns `ir` itself when no
 * entity has instance keys, so a graph with none prints what it did before.
 *
 * Called by `chant graph` and the declared half of `--live`, not by
 * {@link buildGraphIr}, so `chant search`, which reads the base IR, still
 * counts blocks.
 */
export function withInstanceNodes(ir: GraphIR, entities: ReadonlyMap<string, Declarable>): GraphIR {
  const byId = new Map(ir.nodes.map((n) => [n.id, n]));
  const added: IRNode[] = [];
  const childrenOf = new Map<string, string[]>();
  for (const [name, entity] of entities) {
    const block = byId.get(name);
    if (!block || block.instanceOf) continue;
    for (const { id, key, scope } of entityInstances(name, entity)) {
      if (byId.has(id)) continue;
      const node: IRNode = {
        id,
        kind: block.kind,
        lexicon: block.lexicon,
        attrs: {},
        instanceOf: name,
        ...(key !== undefined ? { instanceKey: key } : {}),
        ...(scope !== undefined ? { instanceScope: scope } : {}),
      };
      if (block.sourceLoc) node.sourceLoc = { ...block.sourceLoc };
      if (block.compositeParent) node.compositeParent = block.compositeParent;
      if (block.compositeInstance) node.compositeInstance = block.compositeInstance;
      added.push(node);
      byId.set(id, node);
      (childrenOf.get(name) ?? childrenOf.set(name, []).get(name)!).push(id);
    }
  }
  if (added.length === 0) return ir;
  const nodes = [...ir.nodes, ...added].sort((a, b) => a.id.localeCompare(b.id));
  const withChildren = (rec: Record<string, string[]> | undefined): Record<string, string[]> | undefined => {
    if (!rec) return rec;
    const out: Record<string, string[]> = {};
    for (const [k, ids] of Object.entries(rec)) out[k] = [...ids, ...ids.flatMap((id) => childrenOf.get(id) ?? [])].sort();
    return out;
  };
  const groups: IRGroups = { ...ir.groups };
  for (const key of ["byLexicon", "byComposite", "byStack"] as const) {
    const grown = withChildren(ir.groups[key]);
    if (grown) groups[key] = grown;
  }
  return { ...ir, nodes, groups };
}

/**
 * Add what the lexicons' `graphEdges` hooks reported (#3910) to a built IR.
 *
 * A resolved reference between two nodes becomes an edge. When it lands on
 * the same `from`/`to`/`viaAttr` as an edge the AttrRef walk already found
 * (a GitLab `needs:` holding the Job object itself, say), the lexicon's edge
 * replaces it, since the lexicon knows the reference is a `needs` and the walk
 * only knows it is a reference. A reference marked `dangling`, or whose
 * target is not a node, goes on `ir.dangling` as written. One whose `from` is
 * not a node is dropped: there is nothing to hang it on.
 *
 * Pure. Returns `ir` itself when no report added anything, so a project with
 * no CI lexicon prints exactly what it did before.
 */
export function applyLexiconGraphEdges(ir: GraphIR, reports: readonly LexiconGraphEdges[]): GraphIR {
  const nodeIds = new Set(ir.nodes.map((n) => n.id));
  const edgeMap = new Map<string, IREdge>(ir.edges.map((e) => [edgeKey(e), e]));
  const danglingMap = new Map<string, IRDanglingRef>((ir.dangling ?? []).map((d) => [danglingKey(d), d]));
  const byPipeline: Record<string, string[]> = { ...(ir.groups.byPipeline ?? {}) };
  let changed = false;

  for (const report of reports) {
    for (const ref of report.references) {
      if (!nodeIds.has(ref.from)) continue;
      if (ref.dangling || !nodeIds.has(ref.to)) {
        const d: IRDanglingRef = {
          from: ref.from,
          kind: ref.kind,
          path: ref.viaAttr ?? ref.kind,
          value: ref.to,
          ...(ref.crossPipeline ? { crossPipeline: true } : {}),
        };
        danglingMap.set(danglingKey(d), d);
        changed = true;
        continue;
      }
      if (ref.to === ref.from) continue;
      const e: IREdge = {
        from: ref.from,
        to: ref.to,
        kind: ref.kind,
        ...(ref.viaAttr ? { viaAttr: ref.viaAttr } : {}),
        ...(ref.crossPipeline ? { crossPipeline: true } : {}),
      };
      edgeMap.set(edgeKey(e), e);
      changed = true;
    }
    for (const [name, members] of Object.entries(report.pipelines ?? {})) {
      const present = members.filter((m) => nodeIds.has(m));
      if (present.length === 0) continue;
      byPipeline[name] = [...new Set([...(byPipeline[name] ?? []), ...present])].sort();
      changed = true;
    }
  }
  if (!changed) return ir;

  const edges = [...edgeMap.values()].sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)));
  const dangling = [...danglingMap.values()].sort((a, b) => danglingKey(a).localeCompare(danglingKey(b)));
  const groups: IRGroups = { ...ir.groups };
  if (Object.keys(byPipeline).length) groups.byPipeline = sortKeys(byPipeline);
  const out: GraphIR = { ...ir, edges, groups };
  if (dangling.length) out.dangling = dangling;
  return out;
}

/**
 * Add the outputs the lexicons' `workspaceOutputs` hooks report (#3931) to a
 * built IR's `exports`, each on the node that declares it. An output whose
 * name is already exported (a hand-written `output()`) keeps the existing
 * export. Pure. Returns `ir` itself when no report added anything.
 */
export function applyLexiconOutputs(ir: GraphIR, reports: readonly LexiconWorkspaceOutputs[]): GraphIR {
  const nodeIds = new Set(ir.nodes.map((n) => n.id));
  const names = new Set((ir.exports ?? []).map((e) => e.name));
  const added: IRExport[] = [];
  for (const report of reports) {
    for (const o of report.outputs) {
      if (names.has(o.name)) continue;
      names.add(o.name);
      added.push({
        name: o.name,
        ...(nodeIds.has(o.entity) ? { node: o.entity } : {}),
        ...(o.previously && o.previously.length > 0 ? { previously: [...o.previously] } : {}),
      });
    }
  }
  if (added.length === 0) return ir;
  const exports = [...(ir.exports ?? []), ...added].sort((a, b) => a.name.localeCompare(b.name));
  return { ...ir, exports };
}

function danglingKey(d: IRDanglingRef): string {
  return `${d.from}\0${d.path}\0${d.value}`;
}

function sortKeys(rec: Record<string, string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const k of Object.keys(rec).sort()) out[k] = rec[k];
  return out;
}

/** One lexicon's observed resources, keyed by logical name — the output of a
 * plugin's `describeResources()`. The input to {@link buildLiveGraphIr}. */
export interface LiveObservation {
  lexicon: string;
  resources: Record<string, ResourceMetadata>;
  /**
   * Declared entities the lexicon could not observe (#1089), keyed by name.
   * They are not live nodes — but they are not confirmed-absent either, so the
   * overlay must not paint them "pending". See {@link sourceOverlayGraphs}.
   */
  unobserved?: Record<string, UnobservedEntity>;
  /**
   * Relationships the lexicon observed between the resources it read (#1271).
   *
   * Without these an observation can only say what exists, never how it
   * connects — so a fold over topology has nothing to traverse on the live side
   * and a lexicon has to compute derived answers itself and inject them as
   * attributes. Reporting the edges instead lets the one graph fold in
   * {@link import("./graph-effective").enrichEffectiveTopology} do the work,
   * for every lexicon, over live and recorded observations alike.
   *
   * `from`/`to` are node ids in the same space as {@link LiveObservation.resources}
   * keys, so an edge can only reference something the observation also reported.
   */
  edges?: IREdge[];
  /**
   * What each deployed stack publishes (#1279), keyed by stack name. Stack-level
   * by nature, so it is carried here once and projected onto the IR's `exports`
   * rather than copied onto every node's `attrs` — which is what the AWS
   * observation used to do, leaving every VPC with the stack's `expWebIp` and
   * no `CidrBlock` of its own.
   */
  stackExports?: Record<string, Record<string, unknown>>;
}

/**
 * Build the graph IR from **live-observed** resources (`chant graph --live`) —
 * the provisioned graph, not the declared one. This is the C1 half of epic #776:
 * nodes only. Edges are reconstructed separately by the per-lexicon reference
 * resolver (#778); containment grouping by #779. Pure and deterministic given a
 * fixed observation set (nodes and group ids sorted), so the same snapshot yields
 * identical IR.
 *
 * Each node carries the observed `physicalId` (the reference resolver's index
 * key) and `ownership` marker. `attrs` is the resource's observed attributes.
 */
export function buildLiveGraphIr(observations: LiveObservation[]): GraphIR {
  const nodes: IRNode[] = [];
  const byLexicon: Record<string, string[]> = {};
  const byStack: Record<string, string[]> = {};

  for (const { lexicon, resources } of observations) {
    for (const [name, meta] of Object.entries(resources)) {
      const node: IRNode = {
        id: name,
        kind: meta.type,
        lexicon,
        attrs: meta.attributes ?? {},
      };
      if (meta.physicalId) node.physicalId = meta.physicalId;
      // `unknown` is a legitimate verdict on the metadata (#1089) but carries no
      // information for a painter, and the IR's `ownership` field means "a
      // verdict was reached" — so only owned/foreign land on the node.
      if (meta.ownership === "owned" || meta.ownership === "foreign") node.ownership = meta.ownership;
      // Owner-reference chain (#1077): only a resolved `declared` root is
      // carried onto the node — the same "a verdict was reached" rule as
      // ownership above, since `unowned`/`foreign`/`unknown` all mean "no
      // declared owner", which is simply the absence of this field.
      if (meta.ownerChain?.root === "declared") node.runtimeOwner = meta.ownerChain.entity;
      nodes.push(node);
      (byLexicon[lexicon] ??= []).push(name);
      // A live lexicon maps to one deployable stack, same as the source IR.
      (byStack[lexicon] ??= []).push(name);
      // Each present instance of a `count` or `for_each` block is a node of
      // its own under the block's (#4454), so the overlay paints it alone.
      // The block node above is the rollup. An absent or not-observed
      // instance is no live node: the overlay reads that off `instances`.
      for (const inst of meta.instances ?? []) {
        if (inst.verdict !== "present") continue;
        const id = `${name}${inst.key}`;
        const child: IRNode = {
          id,
          kind: meta.type,
          lexicon,
          attrs: { address: inst.address, ...(inst.status ? { status: inst.status } : {}) },
          instanceOf: name,
          instanceKey: inst.key,
        };
        if (inst.physicalId) child.physicalId = inst.physicalId;
        if (inst.ownership === "owned" || inst.ownership === "foreign") child.ownership = inst.ownership;
        nodes.push(child);
        (byLexicon[lexicon] ??= []).push(id);
        (byStack[lexicon] ??= []).push(id);
      }
    }
  }

  nodes.sort((a, b) => a.id.localeCompare(b.id));
  for (const ids of Object.values(byLexicon)) ids.sort();
  for (const ids of Object.values(byStack)) ids.sort();

  const groups: IRGroups = {};
  if (Object.keys(byLexicon).length) groups.byLexicon = sortKeys(byLexicon);
  if (Object.keys(byStack).length) groups.byStack = sortKeys(byStack);

  // Observed relationships (#1271). An edge whose endpoints were not both
  // observed is dropped rather than kept as a dangling reference: the fold
  // resolves ids to nodes, and a half-edge would silently traverse to nothing.
  // Deduped and sorted for the same reason nodes are — the IR is compared and
  // committed, so it has to be stable across reads.
  const observedIds = new Set(nodes.map((n) => n.id));
  const seen = new Set<string>();
  const edges: IREdge[] = [];
  for (const observation of observations) {
    for (const edge of observation.edges ?? []) {
      if (!observedIds.has(edge.from) || !observedIds.has(edge.to)) continue;
      const key = `${edge.from}\u0000${edge.to}\u0000${edge.viaAttr ?? ""}\u0000${edge.toAttr ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push(edge);
    }
  }
  edges.sort(
    (a, b) =>
      a.from.localeCompare(b.from) ||
      a.to.localeCompare(b.to) ||
      (a.viaAttr ?? "").localeCompare(b.viaAttr ?? ""),
  );

  // Stack exports (#1279) land on the IR's `exports`, the same place the
  // declared graph keeps what a stack publishes — not on the member nodes.
  const exports: IRExport[] = [];
  for (const observation of observations) {
    for (const [stack, values] of Object.entries(observation.stackExports ?? {})) {
      for (const [name, value] of Object.entries(values)) exports.push({ name, value, stack });
    }
  }
  exports.sort((a, b) => a.name.localeCompare(b.name) || (a.stack ?? "").localeCompare(b.stack ?? ""));

  return { nodes, edges, groups, ...(exports.length > 0 ? { exports } : {}) };
}

/** How an overlay learns which declared nodes were never looked at (#1089). */
export interface OverlayOptions {
  /**
   * Declared entities the observation could not read, keyed by name (union of
   * every {@link LiveObservation}'s `unobserved`). They are tagged `neutral`
   * instead of `accent`: "not yet provisioned" is a claim the read never
   * supported.
   */
  unobserved?: Record<string, UnobservedEntity>;
}

/** The union of every observation's unobserved entities — the input to the overlays. */
export function collectUnobserved(observations: LiveObservation[]): Record<string, UnobservedEntity> {
  const out: Record<string, UnobservedEntity> = {};
  for (const o of observations) Object.assign(out, o.unobserved ?? {});
  return out;
}

/** Paint status a node carries in an overlay. `neutral` = chant could not look;
 * `runtime` = live, undeclared, owner chain reaches a declared entity (#1077). */
type OverlayNodeStatus = "good" | "warn" | "accent" | "neutral" | "runtime";

function tagStatus(n: IRNode, status: OverlayNodeStatus, unobserved?: UnobservedEntity): IRNode {
  return {
    ...n,
    attrs: {
      ...n.attrs,
      _status: status,
      ...(unobserved ? { _unobserved: unobserved.reason } : {}),
    },
  };
}

/**
 * The paint for a declared instance node (#4454) the live graph has no node
 * for. Its block not observed: `neutral` with the block's reason, since the
 * rollup put the whole block there. Its block live with instances read: the
 * instance is not among them, so `accent`, pending. Its block live with no
 * instance read at all: `neutral`, since nothing said either way. Its block
 * absent: `accent`, like the block.
 */
function missingInstance(n: IRNode, live: ReadonlySet<string>, read: ReadonlySet<string>, unobserved: Record<string, UnobservedEntity>): IRNode {
  const block = n.instanceOf!;
  const u = unobserved[n.id] ?? unobserved[block];
  if (u) return tagStatus(n, "neutral", u);
  if (live.has(block) && !read.has(block)) return tagStatus(n, "neutral");
  return tagStatus(n, "accent");
}

/** The block ids some live instance node names (#4454): the blocks whose read reported instances. */
function blocksWithInstances(live: GraphIR): Set<string> {
  return new Set(live.nodes.map((n) => n.instanceOf).filter((b): b is string => b !== undefined));
}

/**
 * Overlay the declared graph on the provisioned one (#780, `chant graph --live
 * --overlay`) and classify each resource, tagging a `_status` a renderer colours:
 *   - **managed** (declared + provisioned) → `good`
 *   - **runtime** (provisioned, not declared, owner chain reaches a declared
 *     entity — #1077) → `runtime`, e.g. a Pod a declared Deployment's
 *     controller created — expected, not a foreign resource needing attention
 *   - **foreign** (provisioned, not declared, no declared owner) → `warn`
 *   - **pending** (declared, provider confirmed absent) → `accent`
 *   - **unobserved** (declared, chant could not look — #1089) → `neutral`,
 *     plus an `_unobserved` attr carrying the reason
 * Live nodes keep their edges/containment; pending nodes are appended (they have
 * no live edges). Sorted; the live groups pass through unchanged.
 */
export function overlayGraphs(live: GraphIR, declared: GraphIR, opts?: OverlayOptions): GraphIR {
  const declaredById = new Map(declared.nodes.map((n) => [n.id, n]));
  const liveIds = new Set(live.nodes.map((n) => n.id));
  const unobserved = opts?.unobserved ?? {};

  const read = blocksWithInstances(live);

  const nodes: IRNode[] = live.nodes.map((n) => {
    const d = declaredById.get(n.id);
    // A live instance of a declared block whose expansion the source could
    // not count (`count = var.n`) is managed, never foreign (#4454).
    if (!d && n.instanceOf && declaredById.has(n.instanceOf)) return tagStatus(n, "good");
    if (!d) return tagStatus(n, n.runtimeOwner ? "runtime" : "warn");
    // A managed node keeps the composite it was declared in, so `--detail 1`
    // collapses it with its siblings and rolls their status up (#4227).
    const membership = {
      ...(d.compositeInstance ? { compositeInstance: d.compositeInstance } : {}),
      ...(d.compositeParent ? { compositeParent: d.compositeParent } : {}),
    };
    return tagStatus({ ...n, ...membership }, "good");
  });
  for (const n of declared.nodes) {
    if (liveIds.has(n.id)) continue;
    if (n.instanceOf) {
      nodes.push(missingInstance(n, liveIds, read, unobserved));
      continue;
    }
    const u = unobserved[n.id];
    nodes.push(u ? tagStatus(n, "neutral", u) : tagStatus(n, "accent"));
  }
  nodes.sort((a, b) => a.id.localeCompare(b.id));

  return { ...live, nodes };
}

/**
 * Source-anchored overlay (#821) — the inverse of {@link overlayGraphs}. The
 * **declared** graph is the canvas, so its edges are kept: cross-substrate edges
 * (an ECS service wired to a k8s workload) are a source-graph property, since live
 * reconstruction is per-substrate (identifier value-match) and never crosses
 * providers. Use this when the overlay must keep the mixed topology; use
 * `overlayGraphs` when the provisioned graph itself is the subject.
 *
 * Each declared node is classified against live observation and tagged `_status`:
 *   - **managed** (declared + provisioned) → `good`, carrying the observed
 *     `physicalId` / `ownership` onto the declared node
 *   - **pending** (declared, provider confirmed absent) → `accent`
 *   - **unobserved** (declared, chant could not look — #1089) → `neutral`, with
 *     the reason on `_unobserved`. A wrong-cluster or unsupported-kind read used
 *     to paint the whole estate "pending", which is the diagram equivalent of
 *     planning a create for something that already exists.
 * **Foreign** resources (provisioned, not declared, no declared owner) are
 * appended and tagged `warn`; a provisioned-but-undeclared resource whose
 * owner chain reaches a declared entity (#1077) is tagged `runtime` instead —
 * both carry any live-reconstructed edges that touch them, since a declared
 * edge cannot describe an undeclared resource. Declared groups/exports pass
 * through unchanged; nodes and edges are sorted for deterministic output.
 */
export function sourceOverlayGraphs(declared: GraphIR, live: GraphIR, opts?: OverlayOptions): GraphIR {
  const liveById = new Map(live.nodes.map((n) => [n.id, n]));
  const liveIds = new Set(liveById.keys());
  const declaredIds = new Set(declared.nodes.map((n) => n.id));
  // A live instance of a declared block (#4454) the source could not count
  // is managed: appended `good`, and never foreign.
  const managedInstances = live.nodes.filter((n) => !declaredIds.has(n.id) && n.instanceOf !== undefined && declaredIds.has(n.instanceOf));
  const managedInstanceIds = new Set(managedInstances.map((n) => n.id));
  const foreignIds = new Set(live.nodes.filter((n) => !declaredIds.has(n.id) && !managedInstanceIds.has(n.id)).map((n) => n.id));
  const unobserved = opts?.unobserved ?? {};
  const read = blocksWithInstances(live);

  const nodes: IRNode[] = declared.nodes.map((n) => {
    const obs = liveById.get(n.id);
    if (!obs && n.instanceOf) return missingInstance(n, liveIds, read, unobserved);
    if (!obs) {
      const u = unobserved[n.id];
      // unobserved — declared, and nobody looked; not "pending"
      return u ? tagStatus(n, "neutral", u) : tagStatus(n, "accent");
    }
    const merged: IRNode = { ...n }; // managed — carry the observed identity
    if (obs.physicalId) merged.physicalId = obs.physicalId;
    if (obs.ownership) merged.ownership = obs.ownership;
    // ...and what was observed ABOUT it (#1279). The declared canvas holds what
    // the source says; the observation holds what the account says, and a fact
    // like `VpcId` exists only on the second. Dropping it here made every
    // observed property invisible to anything reading the overlaid graph —
    // `search --show VpcId` printed six blank columns, which reads as an estate
    // with no VPCs rather than a read that never happened.
    //
    // Observed wins a collision. The declared value for something like `VpcId`
    // is an unresolved reference to another entity, not an id — the account has
    // the id. Same precedence `enrichLiveAttrs` already uses when it folds live
    // facts onto this graph, so both paths agree on what a name means.
    if (obs.attrs && Object.keys(obs.attrs).length > 0) merged.attrs = { ...n.attrs, ...obs.attrs };
    return tagStatus(merged, "good");
  });
  for (const n of live.nodes) {
    if (!foreignIds.has(n.id)) continue;
    nodes.push(tagStatus(n, n.runtimeOwner ? "runtime" : "warn")); // runtime child or foreign
  }
  for (const n of managedInstances) nodes.push(tagStatus(n, "good"));
  nodes.sort((a, b) => a.id.localeCompare(b.id));

  // Declared edges are the canvas (the cross-substrate topology). Add only the
  // live edges that touch a foreign node — declared edges already cover every
  // declared relationship, so keeping all live edges would double managed ones.
  const seen = new Set(declared.edges.map(edgeKey));
  const edges = [...declared.edges];
  for (const e of live.edges) {
    if (!(foreignIds.has(e.from) || foreignIds.has(e.to))) continue;
    const k = edgeKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    edges.push(e);
  }
  edges.sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)));

  // Observed export values (#1279) join the declared exports by name: the
  // declaration says which node publishes it, the observation says what it
  // currently is. An export only the stack carries is appended.
  const liveExports = live.exports ?? [];
  let exports = declared.exports;
  if (liveExports.length > 0) {
    const byName = new Map(liveExports.map((e) => [e.name, e]));
    const merged: IRExport[] = (declared.exports ?? []).map((e) => {
      const obs = byName.get(e.name);
      if (!obs) return e;
      byName.delete(e.name);
      return { ...e, value: obs.value, ...(obs.stack ? { stack: obs.stack } : {}) };
    });
    for (const e of byName.values()) merged.push(e);
    merged.sort((a, b) => a.name.localeCompare(b.name));
    exports = merged;
  }

  return { ...declared, nodes, edges, ...(exports ? { exports } : {}) };
}
