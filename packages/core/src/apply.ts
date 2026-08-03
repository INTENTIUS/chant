/**
 * The apply contract (#1446) — what a lexicon's applier is allowed to mean.
 *
 * The peer of `./observation.ts`, and it exists for the same reason on the other
 * side of the lifecycle.
 *
 * The read path had two ways to return nothing for a declared entity and no way
 * to tell them apart — "the provider says it is absent" versus "I never looked"
 * — and the second was classifying as `create`. #1089 made that a tri-state and
 * #1201 built a conformance suite so a lexicon could not pass by returning a
 * well-shaped result that still proposed a create.
 *
 * The write path had the identical hole. An applier could skip a resource and
 * report nothing:
 *
 *     const mapper = MAPPERS[r.kind];
 *     if (!mapper) {
 *       console.log(`skip: no mapper for kind ${r.kind}`);
 *       continue;                    // never appears in `applied`, or anywhere
 *     }
 *
 * A caller receiving `{ applied: [...] }` could not distinguish a complete apply
 * from one that dropped half the manifest, and `ApplyOp` had nothing to gate on.
 * A `console.log` on stdout is not a signal in a result, the same way a warn on
 * stderr was not a signal in a change set (#1447 was the concrete bug; #1457
 * found the same shape in two more appliers).
 *
 * The contract is a tri-state, per resource in the plan:
 *
 *   - **APPLIED** — the provider was called and converged. Carries the action
 *     (`created` / `updated` / `unchanged`) and the physical id when resolved.
 *   - **PRUNED** — owned, no longer declared, deleted.
 *   - **NOT-ATTEMPTED** — carrying a total {@link NotAttemptedReason}. Never
 *     silent, never inferred from absence.
 *
 * The three are **disjoint and total**: every resource the applier was given
 * appears in exactly one. That is the assertion the conformance suite exists to
 * make, and the one the gcp skip failed.
 *
 * Compatibility: an applier may keep returning its own shape. The envelope is
 * discriminated by its literal `apply: "v1"` field, the same mechanism
 * `observation: "v1"` uses, so an un-migrated applier normalizes to "everything
 * I was handed, I attempted" and nothing breaks. Reporting NOT-ATTEMPTED
 * requires the envelope — which is the point: you cannot claim the guarantee
 * without adopting the shape that can express its absence.
 */

/**
 * Why a resource in the plan was not attempted. Total: an applier that skips a
 * resource must pick one of these, and consumers may switch exhaustively.
 *
 * - `unsupported-kind` — the lexicon has no mapper/writer for this type. The
 *   resource is declared and simply was not written.
 * - `no-credentials` — no usable credentials/authorization for the target.
 * - `no-binding` — the environment resolves to no concrete target (no cluster
 *   context, no subscription, no resource group, no endpoint).
 * - `dependency-failed` — an upstream resource in the same run failed, so this
 *   one was never reached. Distinct from a failure of its own.
 * - `filtered` — reached but deliberately withheld by a caller-requested scope.
 * - `not-prunable` — an owned orphan of a kind the applier cannot enumerate or
 *   delete. The prune-side shape: not "there was nothing to prune" but "I could
 *   not look for anything to prune here".
 */
export type NotAttemptedReason =
  | "unsupported-kind"
  | "no-credentials"
  | "no-binding"
  | "dependency-failed"
  | "filtered"
  | "not-prunable";

/** Every legal {@link NotAttemptedReason}, for validation and conformance checks. */
export const NOT_ATTEMPTED_REASONS: readonly NotAttemptedReason[] = [
  "unsupported-kind",
  "no-credentials",
  "no-binding",
  "dependency-failed",
  "filtered",
  "not-prunable",
];

/** True when `value` is a legal {@link NotAttemptedReason}. */
export function isNotAttemptedReason(value: unknown): value is NotAttemptedReason {
  return typeof value === "string" && (NOT_ATTEMPTED_REASONS as readonly string[]).includes(value);
}

/** What an apply did to a resource that it did reach. */
export type AppliedAction = "created" | "updated" | "unchanged";

/** Every legal {@link AppliedAction}. */
export const APPLIED_ACTIONS: readonly AppliedAction[] = ["created", "updated", "unchanged"];

/** How a resource is named across appliers whose native vocabularies differ. */
export interface ApplyRef {
  /**
   * The provider's own type name — a CNRM `kind`, an ARM `type`, a
   * CloudFormation resource type, a Fly entity class. Kept verbatim rather than
   * normalized into a chant vocabulary, so an applier stays true to its target.
   */
  kind: string;
  /** The resource's name within its scope. */
  name: string;
}

/** APPLIED — the provider was called and the resource converged. */
export interface AppliedResource extends ApplyRef {
  action: AppliedAction;
  /** Provider-assigned identifier, when the response carried one. */
  physicalId?: string;
}

/** PRUNED — owned, no longer declared, deleted. */
export interface PrunedResource extends ApplyRef {
  /**
   * False when the delete was a no-op because the resource was already gone.
   * Still PRUNED: the applier looked, decided, and acted.
   */
  deleted: boolean;
}

/** NOT-ATTEMPTED — no provider call was made, and why. */
export interface NotAttemptedResource extends ApplyRef {
  reason: NotAttemptedReason;
  /** Detail for the operator: the status and body, the missing binding, the unsupported kind. */
  detail?: string;
}

/**
 * The apply envelope. Explicitly versioned: `apply: "v1"`, which discriminates
 * it from an applier's own return shape.
 */
export interface ApplyResult {
  /** Discriminant + wire version. */
  readonly apply: "v1";
  applied: AppliedResource[];
  pruned?: PrunedResource[];
  /** Omit or leave empty when everything in the plan was attempted. */
  notAttempted?: NotAttemptedResource[];
}

/** Normalized form every consumer works with. All three arrays always present. */
export interface NormalizedApply {
  applied: AppliedResource[];
  pruned: PrunedResource[];
  notAttempted: NotAttemptedResource[];
}

/** True when `value` is the versioned {@link ApplyResult} envelope. */
export function isApplyResult(value: unknown): value is ApplyResult {
  return typeof value === "object" && value !== null && (value as { apply?: unknown }).apply === "v1";
}

/**
 * Build an {@link ApplyResult}. Appliers use this rather than writing the
 * discriminant by hand.
 */
export function applyResult(
  applied: AppliedResource[],
  pruned?: PrunedResource[],
  notAttempted?: NotAttemptedResource[],
): ApplyResult {
  return {
    apply: "v1",
    applied,
    ...(pruned && pruned.length > 0 ? { pruned } : {}),
    ...(notAttempted && notAttempted.length > 0 ? { notAttempted } : {}),
  };
}

/**
 * Normalize an applier's return value.
 *
 * A non-envelope value normalizes to "everything I was handed, I attempted" —
 * an empty `notAttempted`. That is the compatibility path, and it is also
 * exactly the claim an un-migrated applier is implicitly making, so nothing is
 * invented on its behalf.
 *
 * `undefined` normalizes to three empty arrays. An applier that means "I applied
 * nothing because I could not" must say so with {@link notAttemptedAll} rather
 * than returning nothing, for the same reason `unobservedAll` exists on the read
 * side.
 */
export function normalizeApply(value: ApplyResult | Partial<NormalizedApply> | undefined): NormalizedApply {
  if (!value) return { applied: [], pruned: [], notAttempted: [] };
  return {
    applied: value.applied ?? [],
    pruned: value.pruned ?? [],
    notAttempted: value.notAttempted ?? [],
  };
}

/**
 * Mark every named resource NOT-ATTEMPTED with one reason — the whole-run
 * failure case (no credentials, no binding, the transport never came up). Core
 * applies this when an applier throws, so a thrown apply degrades to an honest
 * "did not attempt" per resource instead of an empty result that reads as a
 * successful no-op.
 */
export function notAttemptedAll(
  refs: Iterable<ApplyRef>,
  reason: NotAttemptedReason,
  detail?: string,
): NotAttemptedResource[] {
  return [...refs].map((ref) => ({ ...ref, reason, ...(detail ? { detail } : {}) }));
}

/** A resource's identity within one apply, for disjointness checks. */
export function applyRefKey(ref: ApplyRef): string {
  return `${ref.kind}/${ref.name}`;
}

/**
 * Every resource that appears in more than one bucket. Empty is the contract;
 * a non-empty result means the applier both wrote and skipped the same
 * resource, which is not a state that can be true.
 *
 * Pruned is checked against the other two but not against itself: an applier
 * may legitimately apply a resource and prune a different, same-named one only
 * if their kinds differ, and {@link applyRefKey} already separates those.
 */
export function overlappingRefs(result: NormalizedApply): string[] {
  const seen = new Map<string, Set<string>>();
  const note = (bucket: string, refs: ApplyRef[]): void => {
    for (const ref of refs) {
      const key = applyRefKey(ref);
      (seen.get(key) ?? seen.set(key, new Set()).get(key)!).add(bucket);
    }
  };
  note("applied", result.applied);
  note("pruned", result.pruned);
  note("notAttempted", result.notAttempted);
  return [...seen.entries()].filter(([, buckets]) => buckets.size > 1).map(([key]) => key);
}

/**
 * Resources in `plan` that the result accounts for in no bucket — the silent
 * drop this contract exists to make impossible.
 *
 * The conformance suite's central assertion. Before #1447, gcp's applier failed
 * exactly this: an unmapped kind was in the plan, in no bucket, and the result
 * looked complete.
 */
export function unaccountedRefs(plan: Iterable<ApplyRef>, result: NormalizedApply): string[] {
  const accounted = new Set<string>();
  for (const bucket of [result.applied, result.pruned, result.notAttempted]) {
    for (const ref of bucket) accounted.add(applyRefKey(ref));
  }
  return [...plan].map(applyRefKey).filter((key) => !accounted.has(key));
}
