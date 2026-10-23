/**
 * The one breadth-first edge walk in core.
 *
 * `chant search`'s transitive edge terms (#4359) walk the graph IR, and carve's
 * reachability (#2325) and reference-closed sets (#3909) walk a `TfGraph`. The
 * two graphs have different node and edge shapes but the same walk: an index of
 * each node's edges by direction, built once, and a frontier that steps along
 * it. This module is that walk, generic over what a step carries, so neither
 * caller keeps a traversal of its own.
 *
 * Pure: no IR or Terraform types, no filesystem.
 */

/** Edges grouped by the node they leave (`out`) and the node they enter (`in`). */
export interface Adjacency<E> {
  out: Map<string, E[]>;
  in: Map<string, E[]>;
}

/**
 * Index edges by both ends, once. Looking a node's edges up in here is O(1),
 * where filtering the edge list for them is O(E) per node and O(V·E) per walk
 * (#2325 measured 21 s against 52 ms at 6 000 nodes).
 */
export function adjacencyOf<E extends { from: string; to: string }>(edges: Iterable<E>): Adjacency<E> {
  const idx: Adjacency<E> = { out: new Map(), in: new Map() };
  for (const e of edges) {
    let out = idx.out.get(e.from);
    if (!out) idx.out.set(e.from, (out = []));
    out.push(e);
    let inn = idx.in.get(e.to);
    if (!inn) idx.in.set(e.to, (inn = []));
    inn.push(e);
  }
  return idx;
}

/** One step out of a node: where it lands, and the hops (edges) it took to get there. */
export interface WalkStep<H> {
  far: string;
  hops: readonly H[];
}

/** A node reached by the walk: its id, how many steps from the start, and the hops on the way. */
export interface WalkArrival<H> {
  id: string;
  depth: number;
  hops: H[];
}

export interface WalkOptions<H> {
  /** The steps out of a node. The walk follows exactly these; filter here. */
  steps: (id: string) => readonly WalkStep<H>[];
  /** Arrivals shallower than this are walked through but not offered. Default 1. */
  min?: number;
  /** No step is taken from a node this deep. Default unbounded. */
  max?: number;
  /**
   * Called for each arrival at a depth of at least `min`, in breadth-first
   * order, so a node's first arrival is at its shortest depth. A node can
   * arrive more than once (by several edges, or again past `min` on a cycle);
   * return true to stop the walk and return this arrival.
   */
  arrive?: (arrival: WalkArrival<H>) => boolean;
}

/**
 * Walk breadth-first from one or more start nodes (#4359, #2325).
 *
 * Termination on a cycle: a state is (node, depth capped at `min`). Past the
 * minimum, arriving at a node again by a longer walk can reach nothing the
 * first arrival could not, so it is not queued twice. The state space is
 * finite and the walk always ends, which matters for carve: chant never runs
 * Terraform, so a `depends_on` cycle in a malformed estate reaches it
 * unvalidated.
 *
 * Returns the arrival `arrive` stopped on, or null when the walk ran out.
 */
export function walkBreadthFirst<H>(start: string | Iterable<string>, opts: WalkOptions<H>): WalkArrival<H> | null {
  const min = opts.min ?? 1;
  const max = opts.max ?? Infinity;
  const starts = typeof start === "string" ? [start] : [...start];
  const seen = new Set<string>(starts.map((id) => `${id}|0`));
  let frontier: WalkArrival<H>[] = starts.map((id) => ({ id, depth: 0, hops: [] }));
  while (frontier.length > 0) {
    const next: WalkArrival<H>[] = [];
    for (const s of frontier) {
      if (s.depth >= max) continue;
      for (const step of opts.steps(s.id)) {
        const depth = s.depth + 1;
        const arrival: WalkArrival<H> = { id: step.far, depth, hops: step.hops.length ? [...s.hops, ...step.hops] : s.hops };
        if (depth >= min && opts.arrive?.(arrival)) return arrival;
        const key = `${step.far}|${Math.min(depth, min)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        next.push(arrival);
      }
    }
    frontier = next;
  }
  return null;
}
