/**
 * Carve-out boundary analysis for the strangler-fig emit path (#197).
 *
 * The advisor (#214) ranks *what* is cheap to carve. This is the next step:
 * given a chosen resource, work out the boundary — every dependency edge the
 * carve would cut — so the surviving Terraform can be patched and the resource
 * handed off without destroying it.
 *
 * Pure analysis over the graph, like the scorer. Emitting the chant source
 * (via live import) and generating the TF patches live in the command/bridge
 * layers; this module just classifies the boundary.
 */

import { inboundEdges, outboundEdges } from "./graph";
import { foldParentOf, resolveTier } from "./tier-map";
import { scoreEstate, type Peelability, type ScoreOptions } from "./score";
import { adjacencyOf, type Adjacency } from "../graph-walk";
import type { TfEdge, TfGraph, TfNode } from "./types";

/** One resource in the carve set (the selected node plus its folded sub-resources). */
export interface CarveMember {
  address: string;
  type?: string;
  /** Set when this member is a sub-resource inlined into the selected parent. */
  foldedInto?: string;
}

export type BoundaryDirection = "inbound" | "outbound";

/**
 * A dependency edge the carve cuts.
 *  - inbound  → a survivor depends on the carve set. Bridge: rewrite that
 *    reference to a Terraform `data` source. Required immediately, or the
 *    surviving plan breaks.
 *  - outbound → the carve set depends on a survivor. Bridge: the value enters
 *    chant as a deploy-time input. Deferred until apply; only provenance is
 *    recorded at the observe position.
 *
 * An inbound edge whose survivor is an `output` block (#1638) is the same
 * urgency and the same patch — the output's expression is rewritten onto the
 * data source — but it is called out as `tf-output-rewrite` so a reader can
 * tell a one-line output edit from a resource's rewiring.
 */
export interface BoundaryEdge {
  direction: BoundaryDirection;
  /** The survivor side of the edge. `output.<name>` for an output block. */
  survivor: string;
  /** The carve-set side of the edge. */
  carved: string;
  attrs: string[];
  /**
   * The referring block's own top-level attribute(s) the reference sits in
   * (#998). For an outbound edge this names the carved resource's attribute
   * that reads the survivor — what the deferred input's build parameter is
   * named after on emit. For an output edge it is `["value"]`.
   */
  via: string[];
  /**
   * The patch that bridges the cut, in the surviving source's own vocabulary.
   * Terraform: a `data` source, an `output` expression rewrite, or a deferred
   * deploy-time input. CDK (#1056): `cdk-import` — the surviving app reimports
   * the carved resource by ARN/name — or a `Outputs` rewrite. Open-ended: a
   * reader must tolerate a value it does not know.
   */
  bridge: "tf-data-source" | "tf-output-rewrite" | "cdk-import" | "cfn-output-rewrite" | "deferred-input";
  required: "immediately" | "at-apply";
  /** The two ends live in different CloudFormation templates (#1056). */
  crossStack?: boolean;
}

export interface CarveReport {
  /** The selected resource address. */
  target: string;
  carveSet: CarveMember[];
  /** Peelability of the selected resource (from the #214 scorer). */
  peelability: number;
  inbound: BoundaryEdge[];
  outbound: BoundaryEdge[];
  /** A carve never destroys/recreates; it is reversible via `terraform import`. */
  reversible: true;
  diagnostics: string[];
}

/**
 * The carve set for a selected address: the node itself plus any sub-resources
 * that fold into it (same name, a `foldParentOf` child type whose parent is the
 * selection). Those are carried along and inlined, not left behind.
 */
export function resolveCarveSet(graph: TfGraph, target: string, index?: BoundaryIndex): CarveMember[] {
  const { byAddress, foldChildren } = index ?? boundaryIndex(graph);
  const selected = byAddress.get(target);
  if (!selected) return [];

  const members: CarveMember[] = [{ address: selected.address, type: selected.type }];
  if (selected.kind === "resource" && selected.type) {
    for (const node of foldChildren.get(foldKey(selected.type, selected.name)) ?? []) {
      members.push({ address: node.address, type: node.type, foldedInto: selected.address });
    }
  }
  return members;
}

const foldKey = (parentType: string, name: string): string => `${parentType}\u001f${name}`;

/**
 * What `boundaryReport` looks up per target, built once per graph: nodes by
 * address, the edges by both ends, and each fold parent's children in graph
 * order. Without it each report scans the node and edge lists itself, which
 * over a whole estate is O(V·E) (#4391).
 */
export interface BoundaryIndex {
  byAddress: Map<string, TfNode>;
  adjacency: Adjacency<TfEdge>;
  /** `foldKey(parent type, name)` → resource nodes that fold into that parent. */
  foldChildren: Map<string, TfNode[]>;
}

export function boundaryIndex(graph: TfGraph): BoundaryIndex {
  const foldChildren = new Map<string, TfNode[]>();
  for (const node of graph.nodes) {
    if (node.kind !== "resource" || !node.type) continue;
    const parentType = foldParentOf(node.type);
    if (!parentType) continue;
    const key = foldKey(parentType, node.name);
    const list = foldChildren.get(key);
    if (list) list.push(node);
    else foldChildren.set(key, [node]);
  }
  return {
    byAddress: new Map(graph.nodes.map((n) => [n.address, n])),
    adjacency: adjacencyOf(graph.edges),
    foldChildren,
  };
}

/**
 * Which source the graph came from, and so which vocabulary its bridge patches
 * are named in. Terraform is the default; `cdk` is the read-only cloud-assembly
 * advisor (#1056), where the surviving app reimports rather than adding a
 * `data` source.
 */
export type CarveDialect = "terraform" | "cdk";

export interface BoundaryOptions {
  dialect?: CarveDialect;
  /** Scoring hooks, so `peelability` is the same number the ranking reported. */
  score?: ScoreOptions;
  /**
   * The target's score, when the caller already holds it (`carve advise`).
   * Without it the estate is scored to find it (#4391).
   */
  peelability?: Pick<Peelability, "score">;
  /** `boundaryIndex(graph)`, shared across calls on one graph. */
  index?: BoundaryIndex;
}

/** The bridge patch an inbound cut needs, per source. */
function inboundBridge(dialect: CarveDialect, fromOutput: boolean): BoundaryEdge["bridge"] {
  if (dialect === "cdk") return fromOutput ? "cfn-output-rewrite" : "cdk-import";
  return fromOutput ? "tf-output-rewrite" : "tf-data-source";
}

/**
 * Classify the boundary of carving `target`: the inbound edges that need an
 * immediate data-source patch, and the outbound edges that become deferred
 * deploy-time inputs. Edges internal to the carve set (e.g. a folded
 * sub-resource pointing at its parent) are not boundary work.
 */
export function boundaryReport(graph: TfGraph, target: string, opts: BoundaryOptions = {}): CarveReport | null {
  const dialect = opts.dialect ?? "terraform";
  const carveSet = resolveCarveSet(graph, target, opts.index);
  if (carveSet.length === 0) return null;
  const inSet = new Set(carveSet.map((m) => m.address));

  const inbound: BoundaryEdge[] = [];
  const outbound: BoundaryEdge[] = [];

  for (const member of carveSet) {
    for (const e of (opts.index ? (opts.index.adjacency.in.get(member.address) ?? []) : inboundEdges(graph, member.address))) {
      if (inSet.has(e.from)) continue; // internal edge
      inbound.push({
        direction: "inbound",
        survivor: e.from,
        carved: e.to,
        attrs: e.attrs,
        via: e.via,
        bridge: inboundBridge(dialect, e.fromKind === "output"),
        required: "immediately",
        ...(e.crossStack ? { crossStack: true } : {}),
      });
    }
    for (const e of (opts.index ? (opts.index.adjacency.out.get(member.address) ?? []) : outboundEdges(graph, member.address))) {
      if (inSet.has(e.to)) continue; // internal edge
      outbound.push({
        direction: "outbound",
        survivor: e.to,
        carved: e.from,
        attrs: e.attrs,
        via: e.via,
        bridge: "deferred-input",
        required: "at-apply",
        ...(e.crossStack ? { crossStack: true } : {}),
      });
    }
  }

  const score = opts.peelability ?? scoreEstate(graph, { ...opts.score, radius: false }).find((r) => r.address === target);
  const diagnostics: string[] = [];
  const tierOf = opts.score?.tierOf ?? resolveTier;
  if (
    carveSet[0].type &&
    tierOf(carveSet[0].type) === null &&
    (opts.index?.byAddress ?? new Map(graph.nodes.map((n) => [n.address, n]))).get(target)?.kind === "resource"
  ) {
    diagnostics.push(`No known native mapping for ${carveSet[0].type} — emit will have no target type.`);
  }

  return {
    target,
    carveSet,
    peelability: score?.score ?? 0,
    inbound: dedupeEdges(inbound),
    outbound: dedupeEdges(outbound),
    reversible: true,
    diagnostics,
  };
}

/**
 * The build-parameter name a deferred input's carrying attribute becomes on
 * emit (#998) — shared so bridge notes and emitted `buildParams` agree.
 */
export function deferredParamName(tfAttr: string): string {
  return tfAttr.replace(/\W+/g, "_");
}

/**
 * Collapse duplicate edges (same survivor/carved pair), merging attrs.
 *
 * The map key below joins the two addresses with U+001F (unit separator).
 * A Terraform address is built from HCL identifiers plus `.`, `[`, `]`, `"`
 * and `-`; it cannot contain a C0 control character, so U+001F can never
 * collide with an address component. Keep it that way — this key is never
 * serialized, so a plain, non-printing separator is fine, but it must stay
 * a character no address can produce.
 */
export function dedupeEdges(edges: BoundaryEdge[]): BoundaryEdge[] {
  const byKey = new Map<string, BoundaryEdge>();
  for (const e of edges) {
    const key = `${e.survivor}${e.carved}`;
    const prev = byKey.get(key);
    if (prev) {
      prev.attrs = [...new Set([...prev.attrs, ...e.attrs])].sort();
      prev.via = [...new Set([...prev.via, ...e.via])].sort();
    } else {
      byKey.set(key, { ...e, attrs: [...e.attrs], via: [...e.via] });
    }
  }
  return [...byKey.values()].sort((a, b) => (a.survivor < b.survivor ? -1 : a.survivor > b.survivor ? 1 : 0));
}
