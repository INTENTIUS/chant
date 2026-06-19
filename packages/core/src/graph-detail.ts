import type { GraphIR, IRNode, IREdge } from "./graph-ir";

/**
 * Detail tiers — the diagram "detail dial". Each level is a pure IR → IR
 * transform over the base graph IR (no re-discovery), so every emitter and the
 * painter get them for free. See issue #494 / epic #492.
 *
 * - 0 STACKS      — one node per lexicon; edges are cross-lexicon dependencies
 * - 1 COMPOSITES  — composite instances collapsed to a single node each
 * - 2 DECLARABLES — every resource (the base produced by buildGraphIr)
 * - 3 ATTRIBUTES  — declarables plus the producer attribute on each edge
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
      return ir;
  }
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

/** T1 — collapse each composite instance to one node; internal edges disappear. */
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
      plain.push({ ...n });
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
  return { nodes, edges: sortEdges([...seen.values()]), groups: { byLexicon: byLexiconOf(nodes) } };
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
