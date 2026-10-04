/**
 * A terraform plan's identity (#2300), kept apart from the activities so the
 * change-set adapter (`../change-set.ts`, #3181) can import it without the
 * config loader, the HCL parse or anything else the activities reach. It
 * imports chant's `lifecycle/plan-digest` subpath and nothing more, which is
 * what lets terragucci bundle it into one file (#3421).
 */

import { computePlanDigest } from "@intentius/chant/lifecycle/plan-digest";

/**
 * One resource's proposed change, as a plan digest sees it (#2300) — the
 * projection of a `terraform show -json` `resource_changes` entry that
 * survives into {@link terraformPlanDigest}.
 */
export interface TerraformPlannedChange {
  address: unknown;
  mode: unknown;
  type: unknown;
  name: unknown;
  index: unknown;
  provider_name: unknown;
  deposed: unknown;
  actions: unknown;
  before: unknown;
  after: unknown;
  after_unknown: unknown;
  replace_paths: unknown;
  importing: unknown;
}

/**
 * The change set a `terraform show -json` plan describes, canonicalised
 * (#2300): every proposed change, at its address, with the values that would
 * be written, sorted so two renderings of the same plan project identically.
 *
 * Everything else in the document is dropped, and the drops are the point —
 * see `packages/core/src/lifecycle/plan-digest.ts` for the general rule. Here
 * that means `timestamp` and `terraform_version` (when the plan was taken and
 * by which binary), `format_version` (how it was rendered), `prior_state` and
 * `planned_values` (restatements of the same change set from another angle),
 * `configuration` (the source that produced it, which can be refactored
 * without changing a single proposed action) and `checks` / `relevant_
 * attributes` (diagnostics about the plan, not the plan). What is left is
 * what applying it would do.
 */
export function terraformPlanChangeSet(planJson: unknown): {
  resourceChanges: TerraformPlannedChange[];
  outputChanges: unknown;
} {
  const doc = planJson as { resource_changes?: unknown; output_changes?: unknown } | null | undefined;
  const raw = Array.isArray(doc?.resource_changes) ? doc.resource_changes : [];
  const resourceChanges = raw.map((entry): TerraformPlannedChange => {
    const e = (entry ?? {}) as Record<string, unknown>;
    const change = (e.change ?? {}) as Record<string, unknown>;
    return {
      address: e.address,
      mode: e.mode,
      type: e.type,
      name: e.name,
      index: e.index,
      provider_name: e.provider_name,
      deposed: e.deposed,
      actions: change.actions,
      before: change.before,
      after: change.after,
      after_unknown: change.after_unknown,
      replace_paths: change.replace_paths,
      importing: change.importing,
    };
  });
  // terraform already emits these in address order, but nothing in the format
  // promises it, and a digest that depends on the emitter's iteration order
  // would refuse a plan that is identical in every way that matters.
  resourceChanges.sort((a, b) =>
    `${String(a.address)}\u0000${String(a.deposed ?? "")}`.localeCompare(
      `${String(b.address)}\u0000${String(b.deposed ?? "")}`,
    ),
  );
  return { resourceChanges, outputChanges: doc?.output_changes ?? {} };
}

/**
 * The identity of a terraform plan (#2300): {@link terraformPlanChangeSet}
 * hashed. This is what a `TerraformApplyOp` gate binds its approval to, and
 * what a later run recomputes and compares.
 *
 * Taken over the `show -json` rendering rather than the plan file's bytes on
 * purpose: the file is an opaque, version-stamped archive, and two runs of
 * `plan -out` over an unchanged root produce different bytes. The rendering
 * is the same plan both times.
 */
export function terraformPlanDigest(planJson: unknown): string {
  return computePlanDigest("terraform-plan", terraformPlanChangeSet(planJson));
}
