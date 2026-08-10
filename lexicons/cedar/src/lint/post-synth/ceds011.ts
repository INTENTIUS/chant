/**
 * CEDS011: a policy set with no `forbid` has no floor
 *
 * Cedar's evaluation order is fixed and is the reason `forbid` exists: a
 * `forbid` that matches beats every `permit`, no matter how the permits are
 * written or in what order. That makes a `forbid` the only construct in the
 * language that states an invariant — "never outside the corporate network",
 * "never on a resource marked frozen" — which no later grant can widen.
 *
 * A set built only from permits has none. Every future policy is additive, and
 * the blast radius of a careless one is bounded by nothing. This is a
 * convention rather than a bug, so it warns; the fix is one `forbid` carrying
 * whatever the set's real invariant is.
 *
 * Reported once per policy set, not once per permit.
 */
import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { effectOf, parsedPolicySets } from "./cedar-helpers";

export const ceds011: PostSynthCheck = {
  id: "CEDS011",
  description: "A policy set built entirely from permits carries no forbid to bound them",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const set of parsedPolicySets(ctx)) {
      if (set.entries.length === 0) continue;
      if (set.entries.some((entry) => effectOf(entry.policy) === "forbid")) continue;

      diagnostics.push({
        checkId: "CEDS011",
        severity: "warning",
        message: `Cedar policy set "${set.source}" has ${set.entries.length} policy/policies and no forbid. A forbid beats every permit regardless of order, so it is the only way to state an invariant a later grant cannot widen — add one for whatever this set must never allow.`,
        entity: set.source,
        lexicon: set.lexicon,
      });
    }

    return diagnostics;
  },
};
