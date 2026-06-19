import type { GraphIR, IRNode, IREdge } from "./graph-ir";

/**
 * Lenses — focus the graph IR on a slice without touching the source. Pure
 * IR → IR filters, composable with detail tiers (apply a lens, then view the
 * result at any `--detail`). See issue #495 / epic #492.
 *
 * - `lexicon:<name>` — only nodes in a lexicon
 * - `stack:<name>`   — only one stack's nodes (stacks map to lexicon partitions today)
 * - `blast:<nodeId>` — the transitive neighbourhood of a node: what it depends
 *   on (`--up`), what depends on it (`--down`), or both (default)
 *
 * Every lens drops edges that would dangle and rebuilds group metadata from the
 * surviving nodes, so the result is always a self-consistent graph.
 */
export interface LensSpec {
  kind: "lexicon" | "stack" | "blast";
  target: string;
  /** blast: include upstream producers (what the node depends on). */
  up: boolean;
  /** blast: include downstream dependents (what depends on the node). */
  down: boolean;
}

const KINDS = new Set(["lexicon", "stack", "blast"]);

/** Parse a `--lens` spec. Throws a descriptive Error on a malformed spec. */
export function parseLens(spec: string, opts: { up?: boolean; down?: boolean } = {}): LensSpec {
  const colon = spec.indexOf(":");
  if (colon <= 0 || colon === spec.length - 1) {
    throw new Error(`Invalid --lens "${spec}". Expected <kind>:<target>, e.g. lexicon:gcp or blast:vpc.`);
  }
  const kind = spec.slice(0, colon);
  const target = spec.slice(colon + 1);
  if (!KINDS.has(kind)) {
    throw new Error(`Unknown lens "${kind}". Expected one of: ${[...KINDS].join(", ")}.`);
  }
  // For blast, default to both directions when neither flag is given.
  const both = !opts.up && !opts.down;
  return {
    kind: kind as LensSpec["kind"],
    target,
    up: opts.up ?? both,
    down: opts.down ?? both,
  };
}

/** Apply a lens to the IR. Throws a descriptive Error when the target matches nothing. */
export function applyLens(ir: GraphIR, lens: LensSpec): GraphIR {
  const keep =
    lens.kind === "blast" ? blastSet(ir, lens) : partitionSet(ir, lens);
  return subgraph(ir, keep);
}

/** Node ids for a lexicon/stack lens. */
function partitionSet(ir: GraphIR, lens: LensSpec): Set<string> {
  if (lens.kind === "stack") {
    const members = ir.groups.byStack?.[lens.target] ?? ir.groups.byLexicon?.[lens.target];
    if (members && members.length) return new Set(members);
    // Fall through to a direct scan if groups are absent.
  }
  const keep = new Set<string>();
  for (const n of ir.nodes) if (n.lexicon === lens.target) keep.add(n.id);
  if (keep.size === 0) {
    throw new Error(`No nodes match lens ${lens.kind}:${lens.target}.`);
  }
  return keep;
}

/** Node ids in the transitive neighbourhood of a node. */
function blastSet(ir: GraphIR, lens: LensSpec): Set<string> {
  if (!ir.nodes.some((n) => n.id === lens.target)) {
    throw new Error(`No node "${lens.target}" for lens blast:${lens.target}.`);
  }
  const out = new Map<string, string[]>(); // from -> [to]  (depends-on)
  const inc = new Map<string, string[]>(); // to -> [from]  (depended-on-by)
  const push = (m: Map<string, string[]>, k: string, v: string): void => {
    const arr = m.get(k);
    if (arr) arr.push(v);
    else m.set(k, [v]);
  };
  for (const e of ir.edges) {
    push(out, e.from, e.to);
    push(inc, e.to, e.from);
  }
  const keep = new Set<string>([lens.target]);
  if (lens.up) walk(lens.target, out, keep);
  if (lens.down) walk(lens.target, inc, keep);
  return keep;
}

function walk(start: string, adj: Map<string, string[]>, keep: Set<string>): void {
  const stack = [start];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const next of adj.get(cur) ?? []) {
      if (!keep.has(next)) {
        keep.add(next);
        stack.push(next);
      }
    }
  }
}

/** Restrict the IR to a node set: keep internal edges, rebuild groups. */
function subgraph(ir: GraphIR, keep: Set<string>): GraphIR {
  const nodes: IRNode[] = ir.nodes.filter((n) => keep.has(n.id));
  const edges: IREdge[] = ir.edges.filter((e) => keep.has(e.from) && keep.has(e.to));

  const byLexicon: Record<string, string[]> = {};
  const byComposite: Record<string, string[]> = {};
  for (const n of nodes) {
    (byLexicon[n.lexicon] ??= []).push(n.id);
    if (n.compositeInstance) (byComposite[n.compositeInstance] ??= []).push(n.id);
  }
  const groups: GraphIR["groups"] = {};
  if (Object.keys(byLexicon).length) groups.byLexicon = sortGroups(byLexicon);
  if (Object.keys(byComposite).length) groups.byComposite = sortGroups(byComposite);

  return { nodes, edges, groups };
}

function sortGroups(rec: Record<string, string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const k of Object.keys(rec).sort()) out[k] = rec[k].sort();
  return out;
}
