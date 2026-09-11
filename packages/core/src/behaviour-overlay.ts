/**
 * A behaviour result, in the shape the overlay carries it (#2360, epic #2355).
 *
 * behold reads a prediction off `chant graph --live --overlay`'s IR and never
 * calls an engine itself: one block per entity on `attrs._behaviour`, the
 * channel every other live fact rides on (`_status`, `_release`, `_carve`),
 * and the graph-level half on `meta._behaviour`. Its reader
 * (`behold/src/behaviour.ts`, `validateBehaviourMeta`) takes `meta._behaviour`
 * as `{ engine?, version?, at?, total?, refusal? }` and short-circuits on
 * `refusal`: a refusal is present *instead of* the engine, and a meta with
 * neither is dropped as "meta.engine missing".
 *
 * That last sentence is the whole reason this module exists. What goes on
 * `meta._behaviour` for a refusal is the **entire** {@link BehaviourRefusalReport}
 * — `{ behaviour: "v1", refusal: { cause, reason, remedy, source? } }` — and
 * not the bare {@link BehaviourRefusal} inside it. A bare refusal has `reason`
 * and `remedy` at its top level and no `refusal` key, so behold's reader finds
 * no refusal, then finds no engine, and drops the meta with a diagnostic that
 * names the wrong thing. The contract doc said the wrong type once
 * (#2360's second review comment); this is written against the reader.
 *
 * For a report, `meta._behaviour` is the report's own `meta`: engine, version,
 * `at`, an optional `total`, and `edgeCoverage`, which behold's reader ignores
 * and a consumer that wants to know what a resilience verdict was computed
 * over reads. Each entity's block goes on its node verbatim — the contract's
 * {@link PredictedBehaviour} is field for field the block behold validates.
 *
 * Pure. Nothing here calls an engine; the result is whatever a lexicon's
 * `predictBehaviour` returned.
 */

import {
  isBehaviourRefusalReport,
  type BehaviourRefusalReport,
  type BehaviourReportMeta,
  type BehaviourResult,
  type PredictedBehaviour,
} from "./behaviour";

/** The attribute a behaviour block rides on, on a node and on the graph's meta. */
export const BEHAVIOUR_OVERLAY_ATTR = "_behaviour";

/** What `meta._behaviour` holds: the report's meta, or the whole refusal report. */
export type BehaviourOverlayMeta = BehaviourReportMeta | BehaviourRefusalReport;

/** A behaviour result projected onto the overlay's two channels. */
export interface BehaviourOverlay {
  /** Goes on the IR's `meta`, keyed {@link BEHAVIOUR_OVERLAY_ATTR}. */
  meta: { [BEHAVIOUR_OVERLAY_ATTR]: BehaviourOverlayMeta };
  /**
   * One entry per priced entity, keyed by entity name: what goes on that
   * node's `attrs`, keyed {@link BEHAVIOUR_OVERLAY_ATTR}. Empty for a refusal,
   * because a refusal is present instead of every figure, and empty for an
   * entity that was `unpredicted` — an unpriced node carries no block rather
   * than a block full of zeroes.
   */
  attrs: Record<string, { [BEHAVIOUR_OVERLAY_ATTR]: PredictedBehaviour }>;
}

/**
 * Project a result onto the overlay's channels.
 *
 * A refusal keeps its envelope. behold reads `meta._behaviour.refusal`, and
 * the envelope is also what makes the value self-describing to anything else
 * reading the IR: `behaviour: "v1"` says which contract the refusal is in.
 */
export function behaviourOverlay(result: BehaviourResult): BehaviourOverlay {
  if (isBehaviourRefusalReport(result)) {
    return { meta: { [BEHAVIOUR_OVERLAY_ATTR]: result }, attrs: {} };
  }
  const attrs: BehaviourOverlay["attrs"] = Object.create(null) as BehaviourOverlay["attrs"];
  for (const [name, block] of Object.entries(result.entities)) {
    attrs[name] = { [BEHAVIOUR_OVERLAY_ATTR]: block };
  }
  return { meta: { [BEHAVIOUR_OVERLAY_ATTR]: result.meta }, attrs };
}
