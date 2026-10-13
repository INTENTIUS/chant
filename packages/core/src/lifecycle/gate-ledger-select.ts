/**
 * The rules a gate is decided by, over gate ledger lines already read (#2119,
 * #2300): the pending fact a resolution must be newer than, and the
 * resolution that answers a gate for a plan. They read no git, so
 * `@intentius/chant/gate-decision` bundles them without the ledger's git
 * code (#3763). `./gate-ledger.ts` re-exports them.
 */

import { samePlanDigest } from "./plan-digest";
import type { GateResolutionRecord, PendingGateRecord } from "./gate-ledger";

/** Whether a pending fact has aged out of relevance at `nowIso`. */
export function isPendingGateExpired(record: PendingGateRecord, nowIso: string): boolean {
  return new Date(record.expiresAt).getTime() <= new Date(nowIso).getTime();
}

/** The most recent pending fact for `gate`, expired or not — the anchor {@link latestResolutionSince} measures a resolution against. `undefined` when the gate has never been recorded pending. */
export function latestPendingGate(
  records: PendingGateRecord[],
  gate: string,
): PendingGateRecord | undefined {
  let latest: PendingGateRecord | undefined;
  for (const r of records) {
    if (r.gate !== gate) continue;
    if (!latest || new Date(r.timestamp).getTime() >= new Date(latest.timestamp).getTime()) latest = r;
  }
  return latest;
}

/** The most recent resolution for `gate` recorded after `sinceIso` (a gated tick's own timestamp) — what `chant operator status` uses to tell a resolved gate from a still-pending one. `undefined` when no such resolution exists. */
export function latestResolutionSince(
  records: GateResolutionRecord[],
  gate: string,
  sinceIso: string,
): GateResolutionRecord | undefined {
  const since = new Date(sinceIso).getTime();
  let latest: GateResolutionRecord | undefined;
  for (const r of records) {
    if (r.gate !== gate) continue;
    if (new Date(r.timestamp).getTime() < since) continue;
    if (!latest || new Date(r.timestamp).getTime() >= new Date(latest.timestamp).getTime()) latest = r;
  }
  return latest;
}

/** What {@link latestResolutionForPlan} found for the plan a run is holding. */
export interface PlanBoundResolution {
  /** The resolution that answers this gate for this plan. Absent when nothing does. */
  resolution?: GateResolutionRecord;
  /**
   * Present instead of {@link PlanBoundResolution.resolution} when a
   * resolution stands for this gate but for a different plan — the newest
   * such record, so a refusal can name who approved what and when. Its
   * `planDigest` is `undefined` for a record written before #2300.
   */
  mismatched?: GateResolutionRecord;
}

/**
 * The resolution that answers `gate` for the plan `planDigest` identifies
 * (#2300).
 *
 * The criterion is the digest; recency is only the tiebreak between several
 * resolutions that all match it. That inversion is the whole point of the
 * issue: {@link latestResolutionSince} asks "is there a newer approval",
 * which a run answers yes to no matter what has changed since, and this asks
 * "is there an approval of *this*".
 *
 * - `planDigest` `undefined` — the gate binds no plan (an Op `gate` step
 *   authored with no `plan`). Falls straight through to
 *   {@link latestResolutionSince}: gates that never claimed to bind a plan
 *   behave exactly as they did before #2300.
 * - A resolution whose `planDigest` equals `planDigest` answers the gate.
 * - A resolution for a different plan does not, and comes back as
 *   `mismatched` so the caller can name both digests.
 * - A resolution with no `planDigest` at all — every record written before
 *   #2300 — does not either, and comes back as `mismatched` with an absent
 *   `planDigest`. This is the safe reading of the migration: such a record
 *   proves someone approved something, and nothing about what. Accepting it
 *   once would silently apply the very change this check exists to catch, on
 *   exactly the estates that have been running longest. The cost is one
 *   further `chant approve` per gate after the upgrade, which the refusal
 *   says out loud.
 */
export function latestResolutionForPlan(
  records: GateResolutionRecord[],
  gate: string,
  sinceIso: string,
  planDigest: string | undefined,
): PlanBoundResolution {
  if (planDigest === undefined) {
    const resolution = latestResolutionSince(records, gate, sinceIso);
    return resolution ? { resolution } : {};
  }

  const since = new Date(sinceIso).getTime();
  let matched: GateResolutionRecord | undefined;
  let mismatched: GateResolutionRecord | undefined;
  for (const r of records) {
    if (r.gate !== gate) continue;
    if (new Date(r.timestamp).getTime() < since) continue;
    const newest = (best: GateResolutionRecord | undefined) =>
      !best || new Date(r.timestamp).getTime() >= new Date(best.timestamp).getTime();
    if (samePlanDigest(r.planDigest, planDigest)) {
      if (newest(matched)) matched = r;
    } else if (newest(mismatched)) {
      mismatched = r;
    }
  }

  if (matched) return { resolution: matched };
  return mismatched ? { mismatched } : {};
}
