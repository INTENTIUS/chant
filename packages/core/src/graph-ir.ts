import { relative, isAbsolute } from "node:path";
import { AttrRef } from "./attrref";
import { isAttrRefLike } from "./utils";
import { type Declarable, isDeclarable } from "./declarable";
import { isLexiconOutput, type LexiconOutput } from "./lexicon-output";
import { getProvenance } from "./provenance";
import { INTRINSIC_MARKER } from "./intrinsic";
import type { ResourceMetadata } from "./lexicon";
import type { UnobservedEntity } from "./observation";

/**
 * Graph IR — the engine-neutral, lint-gated representation of a project's
 * resolved infrastructure graph. Painters (mermaid, graphviz, custom SVG) and
 * the agentic diagrammer consume this; it is a pure function of lint-clean
 * source. Every node traces to the file that declared it; every edge is a real
 * cross-resource reference (AttrRef).
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
}

/** A directed dependency: `from` references an attribute of `to`. */
export interface IREdge {
  from: string;
  to: string;
  /** "ref" for an AttrRef-derived edge. */
  kind: "ref";
  /** The consumer-side property the reference flows through, when derivable. */
  viaAttr?: string;
  /** The producer-side attribute referenced (e.g. "id"). Added at detail T3. */
  toAttr?: string;
}

/** Grouping metadata for cluster/subgraph rendering. Maps group name -> node ids. */
export interface IRGroups {
  byLexicon?: Record<string, string[]>;
  byComposite?: Record<string, string[]>;
  /** Deployable-stack grouping (`stackName → nodeIds`). A stack is a lexicon
   * partition today; #513 phase 2 regroups by nested child-project. Consumers
   * (e.g. pinhole's boundary boxes) read this rather than inferring stacks. */
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
}

/** A cross-stack import this stack consumes — a `Parameter` fed from another
 * stack's output at deploy time. A viewer matches an import `name` to another
 * stack's export `name` to draw the cross-stack edge; the parameter's in-stack
 * consumers are ordinary `$ref` edges to `node` (#513). */
export interface IRImport {
  /** Parameter name — the cross-stack handle (e.g. "clusterArn"). */
  name: string;
  /** Logical name of the parameter node. */
  node: string;
}

/** The full graph IR for a project at the default (declarable) detail level. */
export interface GraphIR {
  nodes: IRNode[];
  edges: IREdge[];
  groups: IRGroups;
  /** Outputs this stack publishes for other stacks to import (#513). */
  exports?: IRExport[];
  /** Parameters this stack imports from other stacks. A viewer matches an import's
   * `name` to another stack's export `name` to draw the cross-stack edge; the
   * parameter's in-stack consumers are ordinary `$ref` edges to it (#513). */
  imports?: IRImport[];
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

/** Resolve the producer (logical name) an AttrRef points at. */
function refTarget(ref: AttrRef, reverse: Map<object, string>): string | undefined {
  // Nested refs (under `props`) aren't assigned a logical name by resolveAttrRefs,
  // which only resolves top-level own props — so fall back to the parent's name.
  const parent = ref.parent.deref();
  return ref.getLogicalName() ?? (parent ? reverse.get(parent) : undefined);
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
    return { $intrinsic: true };
  }

  if (seen.has(value)) return undefined; // break cycles
  seen.add(value);

  // Nested declarables (e.g. an inlined property-kind resource) keep their
  // config in a non-enumerable `props` bag, like top-level nodes — project that.
  if (isDeclarable(value)) {
    const out = projectConfig(value, seen, reverse, nodeIds);
    seen.delete(value);
    return out;
  }

  if (Array.isArray(value)) {
    const out = value.map((v) => project(v, seen, reverse, nodeIds)).filter((v) => v !== undefined);
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

const SKIP_KEYS = new Set(["lexicon", "entityType", "kind", "attributes", "Ref"]);

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

/** Collect ref edges from one node, labelling each with its consumer property. */
function collectEdges(
  entity: Declarable,
  from: string,
  nodeIds: Set<string>,
  reverse: Map<object, string>,
): IREdge[] {
  const edges: IREdge[] = [];
  const seen = new Set<unknown>();
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
    // A stack is a lexicon partition (each lexicon serialises to one deployable
    // stack — a CloudFormation template, a CI config). `byStack` mirrors that
    // today; #513 phase 2 will regroup it by nested child-project. It's a
    // distinct axis from `byLexicon` (which is for provenance/colouring), so it's
    // emitted separately even where the two currently coincide.
    (byStack[entity.lexicon] ??= []).push(name);
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
      nodes.push(node);
      (byLexicon[lexicon] ??= []).push(name);
      // A live lexicon maps to one deployable stack, same as the source IR.
      (byStack[lexicon] ??= []).push(name);
    }
  }

  nodes.sort((a, b) => a.id.localeCompare(b.id));
  for (const ids of Object.values(byLexicon)) ids.sort();
  for (const ids of Object.values(byStack)) ids.sort();

  const groups: IRGroups = {};
  if (Object.keys(byLexicon).length) groups.byLexicon = sortKeys(byLexicon);
  if (Object.keys(byStack).length) groups.byStack = sortKeys(byStack);

  return { nodes, edges: [], groups };
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

/** Paint status a node carries in an overlay. `neutral` = chant could not look. */
type OverlayNodeStatus = "good" | "warn" | "accent" | "neutral";

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
 * Overlay the declared graph on the provisioned one (#780, `chant graph --live
 * --overlay`) and classify each resource, tagging a `_status` a renderer colours:
 *   - **managed** (declared + provisioned) → `good`
 *   - **foreign** (provisioned, not declared) → `warn`
 *   - **pending** (declared, provider confirmed absent) → `accent`
 *   - **unobserved** (declared, chant could not look — #1089) → `neutral`,
 *     plus an `_unobserved` attr carrying the reason
 * Live nodes keep their edges/containment; pending nodes are appended (they have
 * no live edges). Sorted; the live groups pass through unchanged.
 */
export function overlayGraphs(live: GraphIR, declared: GraphIR, opts?: OverlayOptions): GraphIR {
  const declaredIds = new Set(declared.nodes.map((n) => n.id));
  const liveIds = new Set(live.nodes.map((n) => n.id));
  const unobserved = opts?.unobserved ?? {};

  const nodes: IRNode[] = live.nodes.map((n) => tagStatus(n, declaredIds.has(n.id) ? "good" : "warn"));
  for (const n of declared.nodes) {
    if (liveIds.has(n.id)) continue;
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
 * **Foreign** resources (provisioned, not declared) are appended and tagged
 * `warn`, together with any live-reconstructed edges that touch them — a declared
 * edge cannot describe an undeclared resource. Declared groups/exports pass
 * through unchanged; nodes and edges are sorted for deterministic output.
 */
export function sourceOverlayGraphs(declared: GraphIR, live: GraphIR, opts?: OverlayOptions): GraphIR {
  const liveById = new Map(live.nodes.map((n) => [n.id, n]));
  const declaredIds = new Set(declared.nodes.map((n) => n.id));
  const foreignIds = new Set(live.nodes.filter((n) => !declaredIds.has(n.id)).map((n) => n.id));
  const unobserved = opts?.unobserved ?? {};

  const nodes: IRNode[] = declared.nodes.map((n) => {
    const obs = liveById.get(n.id);
    if (!obs) {
      const u = unobserved[n.id];
      // unobserved — declared, and nobody looked; not "pending"
      return u ? tagStatus(n, "neutral", u) : tagStatus(n, "accent");
    }
    const merged: IRNode = { ...n }; // managed — carry the observed identity
    if (obs.physicalId) merged.physicalId = obs.physicalId;
    if (obs.ownership) merged.ownership = obs.ownership;
    return tagStatus(merged, "good");
  });
  for (const n of live.nodes) if (foreignIds.has(n.id)) nodes.push(tagStatus(n, "warn")); // foreign
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

  return { ...declared, nodes, edges };
}
