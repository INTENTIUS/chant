/**
 * Transitive reachability over the carve graph (#2325).
 *
 * `inboundEdges`/`outboundEdges` in `graph.ts` answer one hop with a linear
 * scan, which is right for the scorer's depth-1 counts and wrong as the step of
 * a walk: calling it per node per step is O(V²E). This module builds one
 * index per graph instead, and walks it with the same breadth-first walk
 * `chant search` uses (`graph-walk.ts`).
 *
 * Four rules from the spike (docs/design/carve-dependency-blast-radius-spike.md)
 * hold for every walk here and for the set functions in `cuts.ts` built on it:
 *
 *  - Folds contract first. A folded sub-resource is its parent for the walk, so
 *    `aws_s3_bucket_versioning.assets` is never a dependent of
 *    `aws_s3_bucket.assets`, and a node reading the child depends on the
 *    parent.
 *  - Outputs are terminal and counted apart. An `output.<name>` pseudo-address
 *    has no inbound edges, so it never extends a path; it is reported in its
 *    own list.
 *  - Modules and unresolved `count`/`for_each` hide how much a node holds. A
 *    `module.x` node is one node whatever it contains, and `count = 20` is one
 *    node until `--state` resolves it. They are walked through and named, so a
 *    caller can say `unknown` instead of a number.
 *  - Cross-stack hops are told apart. On the CDK path an `Fn::ImportValue` edge
 *    carries `crossStack: true`; what is reachable only through one is listed
 *    separately.
 *
 * Pure, like the rest of the carve analysis. `src/cdk/graph.ts` emits the same
 * `TfGraph`, so one implementation covers both sources.
 */

import { adjacencyOf, walkBreadthFirst, type Adjacency } from "../graph-walk";
import { computeFolds } from "./folds";
import type { TfEdge, TfGraph, TfNode } from "./types";

/** An edge with both ends contracted to their fold parents. `edge` is the edge as the graph holds it. */
export interface ContractedEdge extends TfEdge {
  edge: TfEdge;
}

/** The index every walk over one graph shares. Built once per graph; see {@link carveIndex}. */
export interface CarveIndex {
  graph: TfGraph;
  /** Every node by address, folded sub-resources included. */
  nodes: Map<string, TfNode>;
  /** The address a walk sees for `address`: its fold parent, or itself. */
  rep(address: string): string;
  /** A walked node's own blocks: itself first, then what folds into it, sorted. */
  membersOf(address: string): string[];
  /** Contracted edges by both ends. An edge internal to one fold is dropped. */
  adj: Adjacency<ContractedEdge>;
  /** The graph has at least one `crossStack` edge (a CDK assembly of several stacks). */
  crossStack: boolean;
}

const indexes = new WeakMap<TfGraph, CarveIndex>();

/**
 * The fold-contracted adjacency index for a graph, built on first use and
 * cached against the graph object. O(V+E) to build; every walk after that is
 * O(V+E). A caller that mutates `graph.edges` after the first walk must pass a
 * new graph object (`applyStateCounts` only touches node instance counts, which
 * the index reads live).
 */
export function carveIndex(graph: TfGraph): CarveIndex {
  const cached = indexes.get(graph);
  if (cached) return cached;
  const nodes = new Map(graph.nodes.map((n) => [n.address, n]));
  const parentOf = new Map<string, string>();
  const { childrenOf } = computeFolds(graph);
  for (const [parent, children] of childrenOf) for (const child of children) parentOf.set(child, parent);
  const rep = (address: string): string => parentOf.get(address) ?? address;
  const contracted: ContractedEdge[] = [];
  for (const e of graph.edges) {
    const from = rep(e.from);
    const to = rep(e.to);
    if (from === to) continue; // a folded child reading its own parent is not an edge of the fold
    contracted.push({ ...e, from, to, edge: e });
  }
  const index: CarveIndex = {
    graph,
    nodes,
    rep,
    membersOf: (address) => [address, ...[...(childrenOf.get(address) ?? [])].sort()],
    adj: adjacencyOf(contracted),
    crossStack: graph.edges.some((e) => e.crossStack),
  };
  indexes.set(graph, index);
  return index;
}

/** `output.<name>`: a pseudo-address `buildGraph` gives an output block's edges (#1638). */
export function isOutputAddress(address: string): boolean {
  return address.startsWith("output.");
}

/**
 * Whether a node stands for an amount of infrastructure the graph cannot see:
 * a Terraform `module` block (one node, whatever it holds; state is not read
 * inside modules), or a `count`/`for_each` block whose instance count no
 * `.tfstate` resolved. A CDK L3 construct is also `kind: "module"`, but its
 * members are listed and its address is a construct path, so it hides nothing.
 */
export function hidesContents(node: TfNode): boolean {
  if (node.kind === "module" && node.address.startsWith("module.")) return true;
  return node.expansion !== undefined && node.instancesFrom !== "state";
}

/**
 * Which way a walk steps: `in` follows who reads a node (its dependents), `out`
 * what it reads, `both` either (weak connectivity, #3909). An output is
 * terminal every way: it is reached, never stepped from.
 */
export type WalkDirection = "in" | "out" | "both";

/**
 * Walk from `seeds` (already contracted) and return every node reached with its
 * shortest depth, seeds excluded. `sameStack` refuses `crossStack` edges.
 */
export function walkFrom(
  index: CarveIndex,
  seeds: Iterable<string>,
  direction: WalkDirection,
  opts: { sameStack?: boolean } = {},
): Map<string, number> {
  const start = new Set(seeds);
  const reached = new Map<string, number>();
  const stepsAlong = (edges: ContractedEdge[] | undefined, far: "from" | "to"): { far: string; hops: never[] }[] =>
    (edges ?? []).filter((e) => !(opts.sameStack && e.crossStack)).map((e) => ({ far: e[far], hops: [] }));
  walkBreadthFirst<never>(start, {
    steps: (id) => {
      if (isOutputAddress(id) && !start.has(id)) return [];
      const steps: { far: string; hops: never[] }[] = [];
      if (direction !== "out") steps.push(...stepsAlong(index.adj.in.get(id), "from"));
      if (direction !== "in") steps.push(...stepsAlong(index.adj.out.get(id), "to"));
      return steps;
    },
    arrive: ({ id, depth }) => {
      if (!start.has(id) && !reached.has(id)) reached.set(id, depth);
      return false;
    },
  });
  return reached;
}

/** What a walk from one node reached. Every list is sorted and holds contracted addresses. */
export interface Reach {
  /** The node the walk started from: the requested address, or its fold parent. */
  address: string;
  /** Resource and module nodes reached, the start excluded. */
  resources: string[];
  /** `output.<name>` pseudo-addresses reached; terminal, never in `resources`. */
  outputs: string[];
  /** The longest shortest path to anything reached, outputs included; 0 when nothing was. */
  depth: number;
  /** Of `resources`, those reached only through a `crossStack` edge. Empty off the CDK path. */
  crossStack: string[];
  /** Of `resources`, those that hide how much they hold (see {@link hidesContents}). */
  hidden: string[];
}

/**
 * Everything reachable from `address` (#2325). Direction `in` (the default)
 * walks dependents: what a change to `address` reaches, its blast radius.
 * Direction `out` walks dependencies: what `address` needs.
 *
 * Throws when `address` is not a node of the graph.
 */
export function reach(graph: TfGraph, address: string, opts: { direction?: WalkDirection } = {}): Reach {
  const index = carveIndex(graph);
  if (!index.nodes.has(address)) throw new Error(`reach: ${address} is not a resource or module in this graph`);
  const start = index.rep(address);
  const direction = opts.direction ?? "in";
  const reached = walkFrom(index, [start], direction);
  const sorted = [...reached.keys()].sort(cmp);
  const resources = sorted.filter((a) => !isOutputAddress(a));
  let crossStack: string[] = [];
  if (index.crossStack) {
    const inStack = walkFrom(index, [start], direction, { sameStack: true });
    crossStack = resources.filter((a) => !inStack.has(a));
  }
  return {
    address: start,
    resources,
    outputs: sorted.filter(isOutputAddress),
    depth: Math.max(0, ...reached.values()),
    crossStack,
    hidden: resources.filter((a) => hidesContents(index.nodes.get(a)!)),
  };
}

/** Code-point order, as `buildGraph` sorts: locale-independent. */
export function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * How far a change to one node reaches, as `carve advise` reports it (#2326):
 * its own axis beside the peelability score, never a penalty term. Every score
 * term is a unit of work (an inbound edge is one data-source patch); a
 * transitive dependent is not work, nobody patches it, and its count can run
 * far past what a 0-100 score carries.
 */
export interface BlastRadius {
  /**
   * Resources and modules that depend on the node, directly or not, weighted by
   * instance count when `--state` resolved it. `"unknown"` when one of them is
   * a module or a `count`/`for_each` no state resolved: see `hiddenBy`.
   */
  resources: number | "unknown";
  /** `output` blocks that read the node or one of its dependents. */
  outputs: number;
  /** Hops to the farthest dependent, outputs included; 0 when nothing depends on it. */
  depth: number;
  /**
   * Of `resources`, those reachable only through a `crossStack` edge (a CDK
   * `Fn::ImportValue`), weighted the same way. Present only when the graph has
   * such an edge.
   */
  crossStack?: number | "unknown";
  /** The dependents that make a count `"unknown"`. Present only when one does. */
  hiddenBy?: string[];
}

/** The instances `addresses` stand for, or `"unknown"` when one of them hides its contents. */
export function weigh(index: CarveIndex, addresses: readonly string[]): number | "unknown" {
  let total = 0;
  for (const address of addresses) {
    const node = index.nodes.get(address)!;
    if (hidesContents(node)) return "unknown";
    total += node.instances;
  }
  return total;
}

/** The {@link BlastRadius} of `address`: its {@link reach} through dependents, counted. */
export function blastRadius(graph: TfGraph, address: string): BlastRadius {
  const index = carveIndex(graph);
  const r = reach(graph, address);
  return {
    resources: weigh(index, r.resources),
    outputs: r.outputs.length,
    depth: r.depth,
    ...(index.crossStack ? { crossStack: weigh(index, r.crossStack) } : {}),
    ...(r.hidden.length ? { hiddenBy: r.hidden } : {}),
  };
}
