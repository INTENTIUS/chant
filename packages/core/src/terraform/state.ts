/**
 * Opt-in `.tfstate` reader for the carve-out advisor (#214 T2).
 *
 * A `.tf`-only parse cannot know how many instances a `count`/`for_each` block
 * expands to — it reports 1 and flags the node dynamic. State is where those
 * are unrolled: each managed resource carries an `instances` array with one
 * entry per expansion. Feeding state in makes the `-3*(instances-1)` penalty
 * accurate, so a 200-instance fan-out ranks as the boundary work it really is.
 *
 * This is deliberately separate and opt-in (`--state <path>`): a pure-`.tf`
 * parse is a plain file read, while reading state pulls in a state backend's
 * output. JSON only — no HCL, no wasm.
 */

import { readFileSync } from "fs";
import type { TfGraph } from "./types";

/** The subset of tfstate v4 the advisor reads. */
interface TfStateResource {
  module?: string;
  mode?: "managed" | "data";
  type: string;
  name: string;
  instances?: unknown[];
}
interface TfState {
  version?: number;
  resources?: TfStateResource[];
}

/**
 * Map each root-module managed resource address to its state-expanded instance
 * count. Resources nested in a `module` are skipped: the `.tf` graph models a
 * module as a single node, so there is no per-resource node to attach the count
 * to (a documented v1 limitation — module internals are not descended into).
 */
export function readStateInstanceCounts(statePath: string): Map<string, number> {
  const raw = readFileSync(statePath, "utf-8");
  const state = JSON.parse(raw) as TfState;
  const counts = new Map<string, number>();
  for (const res of state.resources ?? []) {
    if (res.mode === "data") continue; // data sources are not carvable nodes
    if (res.module) continue; // nested in a module → no top-level node to map
    const address = `${res.type}.${res.name}`;
    counts.set(address, Array.isArray(res.instances) ? res.instances.length : 1);
  }
  return counts;
}

/**
 * Overlay state instance counts onto a graph in place. Nodes absent from state
 * keep their `.tf`-derived count of 1. Returns the same graph for chaining.
 */
export function applyStateCounts(graph: TfGraph, counts: Map<string, number>): TfGraph {
  for (const node of graph.nodes) {
    const n = counts.get(node.address);
    if (n !== undefined) node.instances = Math.max(1, n);
  }
  return graph;
}
