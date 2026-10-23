/**
 * Cuts and reference-closed sets over the carve graph (#3909).
 *
 * `carve advise` scores one block at a time. A consumer splitting one root into
 * several (terragucci's estate carving) needs the same question for a set:
 * which edges cross its boundary and which way, and the smallest set around a
 * seed whose crossings all run a way the caller allows. These are pure
 * functions over `TfGraph`, on the index and walk in `reach.ts`, so the rules
 * there hold here too: folds contract first, outputs are terminal and counted
 * apart, modules and unresolved `count` are named as hiding their contents, a
 * `depends_on` cycle terminates, and `crossStack` edges are counted apart.
 *
 * Nothing here ranks sets, reads state or plan times, writes HCL, or knows
 * about roots or backends; that stays with the consumer.
 */

import { carveIndex, cmp, hidesContents, isOutputAddress, walkFrom, weigh, type CarveIndex } from "./reach";
import type { TfEdge, TfGraph } from "./types";

/** Cut edges of one direction, counted. */
export interface CutCount {
  /** Edges whose reading side is a resource or module block. */
  resources: number;
  /** Edges whose reading side is an `output` block. */
  outputs: number;
  /** Of all of them, the `crossStack` edges (a CDK `Fn::ImportValue`). */
  crossStack: number;
}

/** A set of blocks, as the walks see it. */
export interface BlockSet {
  /** Resource and module addresses, each fold parent with the blocks folded into it. Sorted. */
  resources: string[];
  /** `output.<name>` pseudo-addresses in the set. Sorted. */
  outputs: string[];
}

export interface Cuts extends BlockSet {
  /** Edges where something outside reads something inside, as the graph holds them. */
  inbound: TfEdge[];
  /** Edges where something inside reads something outside. */
  outbound: TfEdge[];
  counts: { inbound: CutCount; outbound: CutCount };
  /** Cuts run in both directions: the set can move only with wiring both ways. */
  bothWays: boolean;
}

/** The cut directions a closure may leave: `inbound` (outside may read in), `outbound` (inside may read out), or `none`. */
export type CutAllowance = "inbound" | "outbound" | "none";

export interface Closure extends Cuts {
  /** The seeds as the walk saw them, folds contracted. */
  seeds: string[];
  allow: CutAllowance;
  /**
   * How many resource instances the set stands for: each block once, or its
   * instance count once `--state` resolved it. `"unknown"` where a module or an
   * unresolved `count`/`for_each` hides how much it holds; `hiddenBy` names them.
   */
  instances: number | "unknown";
  hiddenBy?: string[];
}

export interface Component extends BlockSet {
  /** As {@link Closure.instances}. */
  instances: number | "unknown";
  hiddenBy?: string[];
}

/**
 * The graph's weakly connected components (#3909): blocks joined by a
 * reference either way, fold-contracted, each module one node. An output never
 * joins two components, since outputs are terminal; it is listed in every
 * component it reads into. Components are sorted by their first address.
 */
export function components(graph: TfGraph): Component[] {
  const index = carveIndex(graph);
  const assigned = new Set<string>();
  const found: Component[] = [];
  for (const address of [...index.nodes.keys()].sort(cmp)) {
    const start = index.rep(address);
    if (assigned.has(start)) continue;
    const reached = walkFrom(index, [start], "both");
    const reps = [start, ...[...reached.keys()].filter((a) => !isOutputAddress(a))];
    for (const rep of reps) assigned.add(rep);
    found.push({ ...blockSet(index, reps, [...reached.keys()].filter(isOutputAddress)), ...holdings(index, reps) });
  }
  return found;
}

/**
 * Every edge crossing the boundary of `addresses` (#3909). A folded block in
 * the set brings its parent and siblings, and a fold parent its folded blocks,
 * before anything is counted, so an edge inside one fold is never a cut. An
 * `output.<name>` in the set is inside it like any block.
 *
 * Throws when an address is not a block of the graph.
 */
export function cuts(graph: TfGraph, addresses: Iterable<string>): Cuts {
  const index = carveIndex(graph);
  return cutsOf(index, contract(index, addresses));
}

/**
 * The smallest superset of `seeds` whose remaining cuts all run in the
 * direction `allow` permits, plus those cuts (#3909).
 *
 *  - `outbound`: nothing outside may read in, so the set takes every
 *    dependent of the seeds, outputs included.
 *  - `inbound`: nothing inside may read out, so the set takes everything the
 *    seeds depend on.
 *  - `none`: the seeds' whole components, with each output that reads only
 *    into them.
 *
 * Outputs are terminal, so none of these walks passes through one. An output
 * that reads both the set and something outside it is therefore a cut no
 * closure removes: under `none` it stays outside and its read into the set is
 * left as an inbound cut, for the caller to wire.
 */
export function closure(graph: TfGraph, seeds: Iterable<string>, allow: CutAllowance): Closure {
  const index = carveIndex(graph);
  const start = contract(index, seeds);
  const direction = allow === "outbound" ? "in" : allow === "inbound" ? "out" : "both";
  const members = new Set([...start, ...walkFrom(index, start, direction).keys()]);
  if (allow === "none") {
    for (const address of [...members]) {
      if (!isOutputAddress(address) || start.has(address)) continue;
      const reads = (index.adj.out.get(address) ?? []).map((e) => e.to);
      if (!reads.every((to) => members.has(to))) members.delete(address);
    }
  }
  const found = cutsOf(index, members);
  return {
    ...found,
    seeds: [...start].sort(cmp),
    allow,
    ...holdings(index, [...members].filter((a) => !isOutputAddress(a))),
  };
}

/** The addresses as the walks see them: each fold child replaced by its parent. Throws on an unknown address. */
function contract(index: CarveIndex, addresses: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const address of addresses) {
    const known = index.nodes.has(address) || (isOutputAddress(address) && index.adj.out.has(address));
    if (!known) throw new Error(`carve: ${address} is not a resource, module or output in this graph`);
    out.add(index.rep(address));
  }
  return out;
}

function cutsOf(index: CarveIndex, members: ReadonlySet<string>): Cuts {
  const inbound: TfEdge[] = [];
  const outbound: TfEdge[] = [];
  for (const address of members) {
    for (const e of index.adj.in.get(address) ?? []) if (!members.has(e.from)) inbound.push(e.edge);
    for (const e of index.adj.out.get(address) ?? []) if (!members.has(e.to)) outbound.push(e.edge);
  }
  const byEnds = (a: TfEdge, b: TfEdge): number => cmp(a.from, b.from) || cmp(a.to, b.to);
  inbound.sort(byEnds);
  outbound.sort(byEnds);
  const reps = [...members];
  return {
    ...blockSet(index, reps.filter((a) => !isOutputAddress(a)), reps.filter(isOutputAddress)),
    inbound,
    outbound,
    counts: { inbound: countOf(inbound), outbound: countOf(outbound) },
    bothWays: inbound.length > 0 && outbound.length > 0,
  };
}

function countOf(edges: readonly TfEdge[]): CutCount {
  const outputs = edges.filter((e) => e.fromKind === "output").length;
  return { resources: edges.length - outputs, outputs, crossStack: edges.filter((e) => e.crossStack).length };
}

function blockSet(index: CarveIndex, reps: readonly string[], outputs: readonly string[]): BlockSet {
  return {
    resources: reps.flatMap((rep) => index.membersOf(rep)).sort(cmp),
    outputs: [...outputs].sort(cmp),
  };
}

function holdings(index: CarveIndex, reps: readonly string[]): { instances: number | "unknown"; hiddenBy?: string[] } {
  const instances = weigh(index, reps);
  if (instances !== "unknown") return { instances };
  return { instances, hiddenBy: reps.filter((a) => hidesContents(index.nodes.get(a)!)).sort(cmp) };
}
