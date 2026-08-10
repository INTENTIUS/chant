import type { GraphIR, IRNode, IREdge } from "./graph-ir";

/**
 * Detail tiers — the diagram "detail dial". Each level is a pure IR → IR
 * transform over the base graph IR (no re-discovery), so every emitter and the
 * painter get them for free. See issue #494 / epic #492.
 *
 * The dial moves two things: the graph's shape (what collapses) and each
 * node's attribute payload (how much of the resource reaches the node). The
 * payload is monotonic — a node's attrs at level n are a subset of its attrs
 * at level n+1 — so a consumer stepping through the levels always sees the
 * graph grow (#1489):
 *
 * - 0 STACKS      — one node per lexicon; edges are cross-lexicon deps; no attrs
 * - 1 COMPOSITES  — composite instances collapsed to a single node each;
 *                   topology view — attrs carry only overlay paint (`_*`)
 *                   and composite membership
 * - 2 DECLARABLES — every resource; the resource view of its attrs — scalar
 *                   fields and reference envelopes, not nested property trees
 * - 3 ATTRIBUTES  — declarables carrying the full property tree, plus the
 *                   producer attribute on each reference edge
 *
 * Before #1489 the dial never touched attrs: every level carried the full
 * projected config, and T3's only delta over T2 (the producer attribute on
 * `$ref`-derived edges) is empty for a lexicon whose resources link by
 * name/label convention — the k8s lexicon end to end — so levels 2 and 3 came
 * out byte-identical and a zoom picker mapped onto them rendered the same
 * graph twice (behold#131).
 */
export type DetailLevel = 0 | 1 | 2 | 3;

export const DETAIL = {
  STACKS: 0,
  COMPOSITES: 1,
  DECLARABLES: 2,
  ATTRIBUTES: 3,
} as const;

/** Apply a detail tier to the base (declarable-level) IR. */
export function applyDetail(ir: GraphIR, level: DetailLevel): GraphIR {
  switch (level) {
    case 0:
      return toStacks(ir);
    case 1:
      return toComposites(ir);
    case 3:
      return toAttributes(ir);
    case 2:
    default:
      return toDeclarables(ir);
  }
}

/** Overlay paint (`_status`, `_unobserved`, …) is a verdict about the node,
 * not a property of the resource — it survives every tier above STACKS so a
 * zoomed-out drift view keeps its colours. */
function paintAttrs(attrs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) if (k.startsWith("_")) out[k] = v;
  return out;
}

/** A `{ $ref: "producer.attribute" }` envelope — a reference, not a property tree. */
function isRefEnvelope(v: unknown): boolean {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    typeof (v as { $ref?: unknown }).$ref === "string"
  );
}

/** T2's resource view of a node's attrs: overlay paint, scalar fields
 * (identity, status-relevant values), and top-level reference envelopes.
 * Nested property trees — a k8s `spec`/`metadata`, a Tags list — wait for T3. */
function resourceAttrs(attrs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("_") || v === null || typeof v !== "object" || isRefEnvelope(v)) {
      out[k] = v;
    }
  }
  return out;
}

function edgeSortKey(e: IREdge): string {
  return `${e.from}\0${e.to}\0${e.viaAttr ?? ""}`;
}

function sortEdges(edges: IREdge[]): IREdge[] {
  return edges.sort((a, b) => edgeSortKey(a).localeCompare(edgeSortKey(b)));
}

function byLexiconOf(nodes: IRNode[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const n of nodes) (out[n.lexicon] ??= []).push(n.id);
  const sorted: Record<string, string[]> = {};
  for (const k of Object.keys(out).sort()) sorted[k] = out[k].sort();
  return sorted;
}

/** T0 — collapse every resource to its lexicon; edges become cross-lexicon deps. */
function toStacks(ir: GraphIR): GraphIR {
  const lexOf = new Map(ir.nodes.map((n) => [n.id, n.lexicon]));
  const lexicons = [...new Set(ir.nodes.map((n) => n.lexicon))].sort();
  const nodes: IRNode[] = lexicons.map((l) => ({ id: l, kind: "stack", lexicon: l, attrs: {} }));

  const seen = new Map<string, IREdge>();
  for (const e of ir.edges) {
    const from = lexOf.get(e.from);
    const to = lexOf.get(e.to);
    if (!from || !to || from === to) continue;
    const key = `${from}\0${to}`;
    if (!seen.has(key)) seen.set(key, { from, to, kind: "ref" });
  }
  return { nodes, edges: sortEdges([...seen.values()]), groups: {} };
}

/** T2 — every resource, each carrying the resource view of its attrs (the
 * scalar/reference projection; the full property tree is T3's addition). */
function toDeclarables(ir: GraphIR): GraphIR {
  return { ...ir, nodes: ir.nodes.map((n) => ({ ...n, attrs: resourceAttrs(n.attrs) })) };
}

/** T1 — collapse each composite instance to one node; internal edges disappear.
 * Topology view: surviving plain nodes keep only overlay paint, not properties. */
function toComposites(ir: GraphIR): GraphIR {
  const idMap = new Map<string, string>();
  for (const n of ir.nodes) idMap.set(n.id, n.compositeInstance ?? n.id);

  const instances = new Map<string, IRNode[]>();
  const plain: IRNode[] = [];
  for (const n of ir.nodes) {
    if (n.compositeInstance) {
      const arr = instances.get(n.compositeInstance) ?? [];
      arr.push(n);
      instances.set(n.compositeInstance, arr);
    } else {
      plain.push({ ...n, attrs: paintAttrs(n.attrs) });
    }
  }

  const nodes: IRNode[] = [...plain];
  for (const [inst, members] of instances) {
    const types = new Set(members.map((m) => m.compositeParent).filter(Boolean) as string[]);
    const lexicons = new Set(members.map((m) => m.lexicon));
    nodes.push({
      id: inst,
      kind: types.size === 1 ? [...types][0] : "Composite",
      lexicon: lexicons.size === 1 ? [...lexicons][0] : "multi",
      attrs: { members: members.length },
    });
  }

  const seen = new Map<string, IREdge>();
  for (const e of ir.edges) {
    const from = idMap.get(e.from) ?? e.from;
    const to = idMap.get(e.to) ?? e.to;
    if (from === to) continue; // edge internal to a composite
    // A property label only makes sense when neither endpoint was collapsed.
    const collapsed = from !== e.from || to !== e.to;
    const edge: IREdge = collapsed
      ? { from, to, kind: "ref" }
      : { from, to, kind: "ref", viaAttr: e.viaAttr };
    const key = `${from}\0${to}\0${edge.viaAttr ?? ""}`;
    if (!seen.has(key)) seen.set(key, edge);
  }

  nodes.sort((a, b) => a.id.localeCompare(b.id));
  // Carry the cross-stack import list forward: parameter/import nodes aren't
  // composites, so they survive the collapse as plain nodes — a viewer that
  // hides imports (or matches them across stacks) needs `imports` at every tier,
  // not just the base + ATTRIBUTES. Filter to handles whose node survived.
  const surviving = new Set(nodes.map((n) => n.id));
  const imports = ir.imports?.filter((i) => surviving.has(i.node));
  return {
    nodes,
    edges: sortEdges([...seen.values()]),
    groups: { byLexicon: byLexiconOf(nodes) },
    ...(imports && imports.length ? { imports } : {}),
  };
}

/** T3 — annotate each edge with the producer attribute it references. */
function toAttributes(ir: GraphIR): GraphIR {
  const nodeById = new Map(ir.nodes.map((n) => [n.id, n]));
  const edges = ir.edges.map((e) => {
    const node = nodeById.get(e.from);
    const toAttr = node ? findRefAttr(node.attrs, e.to) : undefined;
    return toAttr ? { ...e, toAttr } : { ...e };
  });
  return { ...ir, edges };
}

/** Find the attribute in a `{ $ref: "producer.attribute" }` envelope under attrs. */
function findRefAttr(attrs: Record<string, unknown>, producer: string): string | undefined {
  let found: string | undefined;
  const visit = (v: unknown): void => {
    if (found !== undefined || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    const ref = (v as { $ref?: unknown }).$ref;
    if (typeof ref === "string") {
      const dot = ref.indexOf(".");
      if (dot > 0 && ref.slice(0, dot) === producer) {
        found = ref.slice(dot + 1);
        return;
      }
    }
    for (const val of Object.values(v as Record<string, unknown>)) visit(val);
  };
  visit(attrs);
  return found;
}

/**
 * chant #1489 — the message to print when `--detail 3` changed nothing.
 *
 * T3 adds two things over T2: the full property tree on each node and the
 * producer attribute on `$ref`-derived edges. A graph whose nodes carry no
 * properties beyond the resource view AND whose edges reference nothing (they
 * link by name or label convention) gains neither, so levels 2 and 3 come out
 * byte-identical — which reads as a broken dial from any consumer stepping
 * through the levels (behold#131 was filed over exactly this). Accepting a
 * value that changes nothing without saying so is the bug; this names it.
 *
 * Returns the warning text, or undefined when detail 3 did add something.
 * `base` is the pre-detail IR the caller already holds (the same one it fed
 * `applyDetail`); the T2 view to compare against is derived here, so callers
 * don't run the projection twice for a message. Pure — no I/O.
 */
export function detailInertNotice(base: GraphIR, detailed: GraphIR): string | undefined {
  if (JSON.stringify(detailed) !== JSON.stringify(toDeclarables(base))) return undefined;
  const edges = base.edges.length;
  const why =
    edges === 0
      ? "this graph has no edges at all"
      : `none of this graph's ${edges} edge(s) reference a producer attribute — they link by name or label convention`;
  return (
    `--detail 3 adds each node's full property tree and the producer attribute on reference edges, ` +
    `but every node's properties already fit the resource view and ${why}, ` +
    `so the output is identical to --detail 2.`
  );
}
