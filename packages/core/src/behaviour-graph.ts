/**
 * The seam between a graph read and a prediction (#2377, epic #2355).
 *
 * `./behaviour-overlay.ts` projects a {@link BehaviourResult} onto the two
 * channels the IR carries it on. This module is the other half: it builds the
 * request from the graph the read already holds, and puts the projection back
 * onto that graph. Both halves are pure, and neither calls an engine — the
 * plugin call itself lives in `./cli/handlers/graph.ts`, which is the only
 * place that has plugins to call.
 *
 * ## The request is the graph, not a second read
 *
 * The epic's rule is that the engine never sees credentials, and the way this
 * path keeps that true is by never reading anything: `chant graph --live`
 * already observed the estate, and {@link behaviourRequestFromIr} reshapes
 * exactly those nodes and edges into the contract's options. There is no
 * provider call here and nothing to leak, because there is no second read to
 * leak from. `screenBehaviourRequest` (`./behaviour-predict.ts`) still screens
 * what this produces; a node whose observed `attrs` picked up a secret is
 * caught there, on the one path every prediction goes through.
 *
 * ## Why `attrs` are the props verbatim
 *
 * An IR node's `attrs` are what the read resolved — literals, and `{ $ref }`
 * for a reference. The contract's `props` is the same thing, so this passes
 * them across unchanged rather than filtering to a "useful" subset. Filtering
 * would be chant deciding which properties can affect a price, and chant does
 * not price anything; an engine that needs a field chant thought irrelevant
 * would get a silently wrong figure with nothing to say so.
 */

import { BEHAVIOUR_OVERLAY_ATTR, type BehaviourOverlay } from "./behaviour-overlay";
import type { GraphIR } from "./graph-ir";
import type { PredictBehaviourOptions } from "./behaviour";

/**
 * What the caller knows and the graph does not.
 *
 * `edgeCoverage` is here rather than derived because this module cannot
 * honestly derive it. Whether the edges in hand are the whole graph depends on
 * which anchoring produced them and which lexicons contributed a reference
 * catalog, and both facts live with the caller.
 */
export interface BehaviourRequestContext
  extends Pick<PredictBehaviourOptions, "environment" | "traffic" | "buildOutput" | "edgeCoverage"> {
  stack?: string;
  region?: string;
  owned?: boolean;
}

/**
 * Reshape an already-read graph into `predictBehaviour`'s options.
 *
 * Entity identity is the node's `id` and nothing derived from it. That is the
 * same key the drift overlay writes `_status` under and the same key
 * {@link applyBehaviourOverlay} reads back, so in a multi-stack project where
 * ids are `${stack}::${logicalId}`, the block lands on the node it was
 * predicted for without this module knowing that qualification exists.
 */
export function behaviourRequestFromIr(ir: GraphIR, ctx: BehaviourRequestContext): PredictBehaviourOptions {
  const entities = new Map<string, { entityType: string; props: Record<string, unknown> }>();
  for (const node of ir.nodes) {
    entities.set(node.id, { entityType: node.kind, props: node.attrs });
  }
  return {
    environment: ctx.environment,
    buildOutput: ctx.buildOutput,
    entityNames: [...entities.keys()],
    entities,
    edges: ir.edges,
    edgeCoverage: ctx.edgeCoverage,
    traffic: ctx.traffic,
    ...(ctx.stack === undefined ? {} : { stack: ctx.stack }),
    ...(ctx.region === undefined ? {} : { region: ctx.region }),
    ...(ctx.owned === undefined ? {} : { owned: ctx.owned }),
  };
}

/**
 * Put a projection back onto the graph: each entity's block on its node's
 * `attrs`, the graph-level half on `ir.meta`.
 *
 * A node with no entry keeps the `attrs` object it already had, untouched —
 * an unpriced entity carries no `_behaviour` key rather than an empty or
 * zeroed one, because zero cost and "not priced" are different claims and a
 * renderer cannot tell them apart after the fact.
 *
 * Returns a new graph and mutates nothing: the caller's `ir` is shared with
 * the lens pipeline downstream, and a prediction is not allowed to be the
 * reason a later pass sees different nodes.
 */
export function applyBehaviourOverlay(ir: GraphIR, overlay: BehaviourOverlay): GraphIR {
  const nodes = ir.nodes.map((node) => {
    const block = overlay.attrs[node.id];
    return block === undefined ? node : { ...node, attrs: { ...node.attrs, ...block } };
  });
  return {
    ...ir,
    nodes,
    meta: { ...(ir.meta ?? {}), [BEHAVIOUR_OVERLAY_ATTR]: overlay.meta[BEHAVIOUR_OVERLAY_ATTR] },
  };
}
