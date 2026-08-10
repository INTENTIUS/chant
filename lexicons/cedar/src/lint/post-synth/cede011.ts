/**
 * CEDE011: surface the Cedar validator's warnings
 *
 * `validate()` returns two arrays, and the second one is the interesting one
 * for a policy nobody has noticed is dead. The validator's warnings are the
 * findings that do not make the set invalid but do mean it is not doing what it
 * says: "policy is impossible: the policy expression evaluates to false for all
 * valid requests" is the one that matters most — a guard whose attribute
 * comparison can never hold, so the grant it wraps never fires and the access
 * it was written to give quietly does not exist.
 *
 * Split from CEDE010 rather than folded into it because the two mean different
 * things: an error is a policy no evaluator will accept, a warning is a policy
 * that will be accepted and will not work. They deserve different severities
 * and, in a report, different lines.
 *
 * Same two traps as CEDE010 — findings live under `type: "success"`, and their
 * order is not stable, so `validatePolicySet` sorts before returning.
 */
import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parsedPolicySets } from "./cedar-helpers";
import { findSchema, loadWasm, normalizePolicySet, validatePolicySet } from "./wasm-helpers";

export const cede011: PostSynthCheck = {
  id: "CEDE011",
  description: "Cedar validation warnings (impossible policies, shadowed conditions) on an emitted policy set",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    const sets = parsedPolicySets(ctx);
    if (sets.length === 0) return diagnostics;

    // Both "no validator" and "no schema" are already reported once by
    // CEDC010/CEDE010; repeating them here would triple the same line.
    const wasm = loadWasm();
    if (!wasm) return diagnostics;
    const schema = findSchema(ctx);
    if (!schema) return diagnostics;

    for (const set of sets) {
      const { policySet } = normalizePolicySet(wasm, set);
      const outcome = validatePolicySet(wasm, policySet, schema.schema);
      if (outcome.failure) continue; // CEDE010 reports the failed call

      for (const finding of outcome.warnings) {
        diagnostics.push({
          checkId: "CEDE011",
          severity: "warning",
          message: `Policy "${finding.policyId}" validates but Cedar warns about it: ${finding.message}`,
          entity: finding.policyId,
          lexicon: set.lexicon,
        });
      }
    }

    return diagnostics;
  },
};
