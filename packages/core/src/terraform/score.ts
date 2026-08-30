/**
 * Peelability scoring for the carve-out advisor (#214 T3).
 *
 * The model, verbatim from #197:
 *
 *   score = 100
 *     - 12 * inbound          # survivors that depend on this → each a TF data-source patch
 *     -  4 * outbound         # this depends on survivors → a deferred deploy-time input
 *     -  4 * outputs          # an output block reads this → a one-line rewrite (#1638)
 *     - 15 * (tier - 1)       # native-spec map: tier1=0, tier2=-15, tier3=-30
 *     - 10 * has_dynamic      # count / for_each / data present
 *     -  3 * (instances - 1)  # state-expanded instance count
 *   clamp 0..100   (unsupported provider/type → 0)
 *
 * An `output` block referencing the target is a real inbound dependency — the
 * surviving plan errors on the dangling reference — so it cannot score as
 * free. It is not a data-source patch either: bridging it rewrites one
 * expression in a block that manages no infrastructure, the same order of work
 * as recording an outbound deferred input. Hence 4, not 12.
 *
 * Sub-resources that inline into a parent (see `foldParentOf`) are folded into the
 * parent's carve set: they are removed from the ranking and their edge to the
 * parent is not counted as inbound — inlining them is free, not boundary work.
 */

import { inboundEdges, outboundEdges } from "./graph";
import { foldParentOf, resolveTier } from "./tier-map";
import type { TfGraph, TfNode } from "./types";

export type PeelabilityBand = "clean leaf" | "carvable w/ edits" | "leave in Terraform";

export interface PeelabilityBreakdown {
  /** Inbound edges from resource/module blocks — a data-source patch each. */
  inbound: number;
  outbound: number;
  /** Inbound edges from `output` blocks — a one-line rewrite each (#1638). */
  outputs: number;
  tier: 1 | 2 | 3 | null;
  hasDynamic: boolean;
  instances: number;
  /** Signed penalty contributions, for report transparency. */
  penalties: {
    inbound: number;
    outbound: number;
    outputs: number;
    tier: number;
    dynamic: number;
    instances: number;
  };
}

export interface Peelability {
  address: string;
  kind: "resource" | "module";
  score: number;
  band: PeelabilityBand;
  /** Native spec type a carve would target; undefined for modules/unsupported. */
  mapsTo?: string;
  breakdown: PeelabilityBreakdown;
}

const clamp = (n: number): number => Math.max(0, Math.min(100, n));

export function bandFor(score: number): PeelabilityBand {
  if (score >= 80) return "clean leaf";
  if (score >= 50) return "carvable w/ edits";
  return "leave in Terraform";
}

/** Module tier: a module maps to a chant composite — reshaping, so tier 2 by default. */
const MODULE_TIER = 2 as const;

/**
 * Build the set of addresses that fold into a parent present in the estate, plus
 * the reverse lookup (parent → its folded children), so a parent can discount
 * inbound edges coming from its own folded sub-resources.
 */
function computeFolds(graph: TfGraph): { folded: Set<string>; childrenOf: Map<string, Set<string>> } {
  const byAddress = new Map(graph.nodes.map((n) => [n.address, n]));
  const folded = new Set<string>();
  const childrenOf = new Map<string, Set<string>>();
  for (const node of graph.nodes) {
    if (node.kind !== "resource" || !node.type) continue;
    const parentType = foldParentOf(node.type);
    if (!parentType) continue;
    const parentAddress = `${parentType}.${node.name}`;
    if (!byAddress.has(parentAddress)) continue; // sub-resource without its parent → score it on its own
    folded.add(node.address);
    if (!childrenOf.has(parentAddress)) childrenOf.set(parentAddress, new Set());
    childrenOf.get(parentAddress)!.add(node.address);
  }
  return { folded, childrenOf };
}

function scoreNode(node: TfNode, graph: TfGraph, foldedChildren: Set<string>): Peelability {
  // Inbound excludes edges from this node's own folded sub-resources, and
  // counts output blocks separately — they cost less to bridge (#1638).
  const inboundAll = inboundEdges(graph, node.address).filter((e) => !foldedChildren.has(e.from));
  const inbound = inboundAll.filter((e) => e.fromKind !== "output").length;
  const outputs = inboundAll.length - inbound;
  const outbound = outboundEdges(graph, node.address).length;

  const tierInfo = node.kind === "module" ? { tier: MODULE_TIER, mapsTo: undefined } : resolveTier(node.type!);
  const tier = tierInfo ? tierInfo.tier : null;

  // Unsupported provider/type → 0, no partial credit.
  if (tier === null) {
    return {
      address: node.address,
      kind: node.kind,
      score: 0,
      band: "leave in Terraform",
      breakdown: {
        inbound,
        outbound,
        outputs,
        tier: null,
        hasDynamic: node.hasDynamic,
        instances: node.instances,
        penalties: { inbound: 0, outbound: 0, outputs: 0, tier: 0, dynamic: 0, instances: 0 },
      },
    };
  }

  const penalties = {
    inbound: -12 * inbound,
    outbound: -4 * outbound,
    outputs: -4 * outputs,
    tier: -15 * (tier - 1),
    dynamic: node.hasDynamic ? -10 : 0,
    instances: -3 * Math.max(0, node.instances - 1),
  };
  const score = clamp(
    100 +
      penalties.inbound +
      penalties.outbound +
      penalties.outputs +
      penalties.tier +
      penalties.dynamic +
      penalties.instances,
  );

  return {
    address: node.address,
    kind: node.kind,
    score,
    band: bandFor(score),
    mapsTo: tierInfo && "mapsTo" in tierInfo ? tierInfo.mapsTo : undefined,
    breakdown: {
      inbound,
      outbound,
      outputs,
      tier,
      hasDynamic: node.hasDynamic,
      instances: node.instances,
      penalties,
    },
  };
}

/**
 * Score every carvable node in the estate, ranked most-peelable first. Folded
 * sub-resources are omitted (they carve with their parent, not on their own).
 */
export function scoreEstate(graph: TfGraph): Peelability[] {
  const { folded, childrenOf } = computeFolds(graph);
  return graph.nodes
    .filter((n) => !folded.has(n.address))
    .map((n) => scoreNode(n, graph, childrenOf.get(n.address) ?? new Set()))
    .sort((a, b) => b.score - a.score || (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
}
