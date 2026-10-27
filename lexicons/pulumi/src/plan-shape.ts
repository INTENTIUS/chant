/**
 * The plan shape of a Pulumi or plunge stack (#4541, item 4): what a preview
 * does, without the values, in the form core's covered rounds compare
 * (`@intentius/chant/components/covered-round`, #4419). The `pulumi-up`
 * capability's `plan` returns it, and a stock apply holds the steps `up`
 * ran to it (ruling A).
 *
 * The shape is read from the member's change-set part (`./change-set.ts`),
 * which already maps a URN's steps to one action and its attributes:
 *
 * - one entry per URN whose action is not `no-op` or `read` (a `same` or
 *   `read` step), at the URN;
 * - `type` is the resource type;
 * - `replacement`: on a replace, `conditional` when every attribute that
 *   forces it (`replaceReasons`, a `detailedDiff` kind ending in
 *   `-replace`) is unknown at preview, else `true`; on an update `false`;
 * - `properties`: the top-level inputs the change writes (`detailedDiff`
 *   and `diffReasons` on an update or replace, every input on a create);
 * - `unknown`: those holding Pulumi's unknown sentinel;
 * - `mayAppear` entries are kept, with no `type` or `properties`, since what
 *   an `apply()` registers is not known at preview.
 *
 * {@link pulumiShapeDifferences} compares an approved shape with a later one.
 * A resource registered under a component the approved shape marks
 * `mayAppear`, or one the approved shape lists as `mayAppear` itself, is
 * within the approval: that is what the mark promised might happen.
 */

import type { ChangeSetPart } from "@intentius/chant/change-set";
import { normalizePlanShape, planShapeDifferences, type PlanShape, type PlanShapeEntry } from "@intentius/chant/components/covered-round";
import { pulumiMayAppearParent } from "@intentius/chant/pulumi-urn";
import type { PulumiStep } from "./change-set";

export interface PulumiPlanShapeOptions {
  /** The inputs the plan was made without, as `<component>.<output>`. */
  unknownInputs?: string[];
  /** The inputs the plan read with a value, by reference. */
  knownInputs?: Record<string, unknown>;
}

/** The shape of a Pulumi member's change-set part, for `member` (the set digest's `<member>/<stack>`). */
export function pulumiPlanShape(part: ChangeSetPart, member: string, opts: PulumiPlanShapeOptions = {}): PlanShape {
  const entries: PlanShapeEntry[] = [];
  for (const e of part.entries) {
    if (e.action === "no-op" || e.action === "read") continue;
    if (e.mayAppear) {
      entries.push({ logicalId: e.address, action: e.action });
      continue;
    }
    const attrs = e.attributes ?? [];
    const forcing = attrs.filter((a) => a.forcesReplacement);
    const replacement =
      e.action === "replace" ? (forcing.length > 0 && forcing.every((a) => a.unknown) ? "conditional" : "true") : e.action === "update" ? "false" : undefined;
    entries.push({
      logicalId: e.address,
      action: e.action,
      ...(replacement ? { replacement } : {}),
      ...(e.type && e.type !== "unknown" ? { type: e.type } : {}),
      properties: attrs.map((a) => a.path),
      unknown: attrs.filter((a) => a.unknown).map((a) => a.path),
    });
  }
  return normalizePlanShape({
    member,
    entries,
    unknownInputs: [...(opts.unknownInputs ?? [])],
    ...(opts.knownInputs ? { knownInputs: opts.knownInputs } : {}),
  });
}

/** Each URN's parent, from the steps' states. */
function parentsOf(steps: readonly PulumiStep[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of steps) {
    const parent = s.newState?.parent ?? s.oldState?.parent;
    if (s.urn && typeof parent === "string" && parent) out.set(s.urn, parent);
  }
  return out;
}

/**
 * Every way `fresh` goes beyond `approved`, as reasons; none means within.
 * `freshSteps` are the steps `fresh` was read from, for the parent chain: an
 * entry under a component the approved shape marks `mayAppear`, and an
 * entry the approved shape lists as `mayAppear`, are dropped before core's
 * `planShapeDifferences` compares the rest.
 */
export function pulumiShapeDifferences(approved: PlanShape, fresh: PlanShape, freshSteps: readonly PulumiStep[] = []): string[] {
  const components = new Set(approved.entries.map((e) => pulumiMayAppearParent(e.logicalId)).filter((c): c is string => typeof c === "string"));
  const mayAppear = new Set(approved.entries.filter((e) => pulumiMayAppearParent(e.logicalId) === undefined && e.type === undefined && e.properties === undefined).map((e) => e.logicalId));
  const parents = parentsOf(freshSteps);
  const underMarked = (urn: string): boolean => {
    const seen = new Set<string>();
    for (let at = parents.get(urn); at !== undefined && !seen.has(at); at = parents.get(at)) {
      seen.add(at);
      if (components.has(at)) return true;
    }
    return false;
  };
  // A mark on the fresh side stands for no resource of its own; what it stands for is compared where it lands.
  const kept = fresh.entries.filter((e) => pulumiMayAppearParent(e.logicalId) === undefined && !mayAppear.has(e.logicalId) && !underMarked(e.logicalId));
  // The approved side's marks name no resource the fresh side can match, so they leave the comparison too.
  const approvedKept = approved.entries.filter((e) => pulumiMayAppearParent(e.logicalId) === undefined && !mayAppear.has(e.logicalId));
  return planShapeDifferences({ ...approved, entries: approvedKept }, { ...fresh, entries: kept });
}
