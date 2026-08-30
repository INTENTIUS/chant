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
 *
 * The model itself is not Terraform-specific — the CDK cloud-assembly advisor
 * (#1056) scores construct units with the same arithmetic. What differs per
 * source is the type→tier lookup and the extra signals that source can see, so
 * both are injectable via `ScoreOptions` rather than forked into a second
 * scorer. Everything else — the six penalty terms, the clamp, the bands — is
 * shared verbatim.
 */

import { inboundEdges, outboundEdges } from "./graph";
import { foldParentOf, resolveTier, type TierInfo } from "./tier-map";
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
  /**
   * Signed penalty contributions, for report transparency. The six shared terms
   * are always present; a source-specific scorer may add its own keys (the CDK
   * advisor's `asset`, say). A reader that sums the values reproduces the score;
   * a reader that only knows the six named terms still reads those correctly.
   */
  penalties: {
    inbound: number;
    outbound: number;
    outputs: number;
    tier: number;
    dynamic: number;
    instances: number;
    [term: string]: number;
  };
}

/**
 * One unit of source a scored node stands for, when the node is a fold of
 * several (#1056). A CDK construct emits 1..n CloudFormation resources and
 * ranks once; this names the resources that carve with it. Absent on the
 * Terraform path, where a fold is expressed by the child's absence from the
 * ranking instead.
 */
export interface CarveUnitMember {
  /** Identifier within its template/estate — a CFN logical ID. */
  id: string;
  /** Resource type, e.g. `AWS::IAM::Role`. */
  type: string;
  /** The template/stack the member lives in. */
  stack?: string;
  /** The member's own source path, e.g. a CDK construct path. */
  path?: string;
}

export interface Peelability {
  address: string;
  kind: "resource" | "module";
  score: number;
  band: PeelabilityBand;
  /** Native spec type a carve would target; undefined for modules/unsupported. */
  mapsTo?: string;
  breakdown: PeelabilityBreakdown;
  /**
   * Source-specific facts about this node that the six penalty terms do not
   * carry — why it was disqualified, what folded into it, what it is. Plain
   * prose, for the report's benefit; nothing keys on it.
   */
  notes?: string[];
  /** The source units folded into this node (#1056). */
  members?: CarveUnitMember[];
}

/**
 * Source-specific scoring input for one node, layered on the shared model.
 * Everything here is optional: with no signals a node scores exactly as the
 * Terraform path scores it.
 */
export interface ScoreSignals {
  /** Extra penalty terms, merged into `breakdown.penalties` and the total. */
  penalties?: Record<string, number>;
  notes?: string[];
  members?: CarveUnitMember[];
  /**
   * When set, the node scores 0 and this is the stated reason. For claims the
   * arithmetic cannot express — a CDK assembly synthesized from dummy lookup
   * values is not a faithful picture of anything, so no score it produces is
   * worth reading.
   */
  disqualified?: string;
}

export interface ScoreOptions {
  /**
   * Resource type → native tier. Defaults to the Terraform tier map; the CDK
   * advisor passes a CloudFormation-keyed one. Modules keep the built-in
   * {@link MODULE_TIER} treatment either way.
   */
  tierOf?: (type: string) => TierInfo | null;
  signalsFor?: (node: TfNode) => ScoreSignals;
}

const clamp = (n: number): number => Math.max(0, Math.min(100, n));

/**
 * `-12 * 0` is `-0`, and JSON has no notation for it — a report written to a
 * file would not equal the one held in memory. A term that costs nothing is 0.
 */
const term = (n: number): number => (n === 0 ? 0 : n);

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

function scoreNode(
  node: TfNode,
  graph: TfGraph,
  foldedChildren: Set<string>,
  opts: ScoreOptions,
): Peelability {
  // Inbound excludes edges from this node's own folded sub-resources, and
  // counts output blocks separately — they cost less to bridge (#1638).
  const inboundAll = inboundEdges(graph, node.address).filter((e) => !foldedChildren.has(e.from));
  const inbound = inboundAll.filter((e) => e.fromKind !== "output").length;
  const outputs = inboundAll.length - inbound;
  const outbound = outboundEdges(graph, node.address).length;

  const signals = opts.signalsFor?.(node) ?? {};
  const extra = { ...(signals.penalties ?? {}) };
  const trimmings = {
    ...(signals.notes?.length ? { notes: signals.notes } : {}),
    ...(signals.members?.length ? { members: signals.members } : {}),
  };

  const tierOf = opts.tierOf ?? resolveTier;
  const tierInfo = node.kind === "module" ? { tier: MODULE_TIER, mapsTo: undefined } : node.type ? tierOf(node.type) : null;
  const tier = tierInfo ? tierInfo.tier : null;

  // Unsupported provider/type, or a source-specific disqualification → 0, no
  // partial credit. The extra penalties are dropped with the rest of the
  // arithmetic: there is no score left for them to reduce.
  if (tier === null || signals.disqualified) {
    return {
      address: node.address,
      kind: node.kind,
      score: 0,
      band: "leave in Terraform",
      ...(tier === null ? {} : { mapsTo: tierInfo && "mapsTo" in tierInfo ? tierInfo.mapsTo : undefined }),
      breakdown: {
        inbound,
        outbound,
        outputs,
        tier,
        hasDynamic: node.hasDynamic,
        instances: node.instances,
        penalties: { inbound: 0, outbound: 0, outputs: 0, tier: 0, dynamic: 0, instances: 0 },
      },
      ...trimmings,
      ...(signals.disqualified ? { notes: [signals.disqualified, ...(signals.notes ?? [])] } : {}),
    };
  }

  const penalties = {
    inbound: term(-12 * inbound),
    outbound: term(-4 * outbound),
    outputs: term(-4 * outputs),
    tier: term(-15 * (tier - 1)),
    dynamic: node.hasDynamic ? -10 : 0,
    instances: term(-3 * Math.max(0, node.instances - 1)),
    ...Object.fromEntries(Object.entries(extra).map(([key, value]) => [key, term(value)])),
  };
  const score = clamp(100 + Object.values(penalties).reduce((sum, n) => sum + n, 0));

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
    ...trimmings,
  };
}

/**
 * Score every carvable node in the estate, ranked most-peelable first. Folded
 * sub-resources are omitted (they carve with their parent, not on their own).
 */
export function scoreEstate(graph: TfGraph, opts: ScoreOptions = {}): Peelability[] {
  const { folded, childrenOf } = computeFolds(graph);
  return graph.nodes
    .filter((n) => !folded.has(n.address))
    .map((n) => scoreNode(n, graph, childrenOf.get(n.address) ?? new Set(), opts))
    .sort((a, b) => b.score - a.score || (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
}
