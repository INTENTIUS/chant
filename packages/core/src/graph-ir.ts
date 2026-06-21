import { relative, isAbsolute } from "node:path";
import { AttrRef } from "./attrref";
import { isAttrRefLike } from "./utils";
import { type Declarable, isDeclarable } from "./declarable";
import { isLexiconOutput } from "./lexicon-output";
import { getProvenance } from "./provenance";
import { INTRINSIC_MARKER } from "./intrinsic";

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
  /** Reserved for stack grouping (#494). */
  byStack?: Record<string, string[]>;
}

/** The full graph IR for a project at the default (declarable) detail level. */
export interface GraphIR {
  nodes: IRNode[];
  edges: IREdge[];
  groups: IRGroups;
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

/** Resolve the producer (logical name) an AttrRef points at. */
function refTarget(ref: AttrRef, reverse: Map<object, string>): string | undefined {
  // Nested refs (under `props`) aren't assigned a logical name by resolveAttrRefs,
  // which only resolves top-level own props — so fall back to the parent's name.
  const parent = ref.parent.deref();
  return ref.getLogicalName() ?? (parent ? reverse.get(parent) : undefined);
}

/** Project a value into a JSON-safe, scrubbed form. References become `{ $ref }`. */
function project(value: unknown, seen: Set<unknown>, reverse: Map<object, string>): unknown {
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
  // Other intrinsics (interpolations, pseudo-parameters): mark, don't inline.
  if ((value as Record<symbol, unknown>)[INTRINSIC_MARKER] === true) {
    return { $intrinsic: true };
  }

  if (seen.has(value)) return undefined; // break cycles
  seen.add(value);

  // Nested declarables (e.g. an inlined property-kind resource) keep their
  // config in a non-enumerable `props` bag, like top-level nodes — project that.
  if (isDeclarable(value)) {
    const out = projectConfig(value, seen, reverse);
    seen.delete(value);
    return out;
  }

  if (Array.isArray(value)) {
    const out = value.map((v) => project(v, seen, reverse)).filter((v) => v !== undefined);
    seen.delete(value);
    return out;
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const p = project(v, seen, reverse);
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
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of configRoots(entity)) {
    const p = project(v, seen, reverse);
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
    if ((value as Record<symbol, unknown>)[INTRINSIC_MARKER] === true) return;
    if (seen.has(value)) return;
    seen.add(value);
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

  for (const [name, entity] of entities) {
    if (!nodeIds.has(name)) continue;
    const prov = getProvenance(entity);
    const node: IRNode = {
      id: name,
      kind: entity.entityType,
      lexicon: entity.lexicon,
      attrs: projectConfig(entity, new Set(), reverse),
    };
    if (prov?.composite) node.compositeParent = prov.composite;
    if (prov?.compositeInstance) node.compositeInstance = prov.compositeInstance;
    const file = relFile(prov?.sourceFile, projectPath);
    if (file) node.sourceLoc = { file };
    nodes.push(node);

    (byLexicon[entity.lexicon] ??= []).push(name);
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

  const groups: IRGroups = {};
  if (Object.keys(byLexicon).length) groups.byLexicon = sortKeys(byLexicon);
  if (Object.keys(byComposite).length) groups.byComposite = sortKeys(byComposite);

  return { nodes, edges, groups };
}

function sortKeys(rec: Record<string, string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const k of Object.keys(rec).sort()) out[k] = rec[k];
  return out;
}
