/**
 * CEDE010: every emitted policy set validates clean against its schema
 *
 * The epic's "native tool is the test" clause: not "the text is well formed"
 * but "Cedar's own validator, run in-process against the project's schema, has
 * nothing to say about it." This is what catches the second meta-policy wall —
 * a policy naming an entity type or an action the schema does not define — and
 * it catches it everywhere, in every environment, because such a policy can
 * never grant anything.
 *
 * Two things about `validate()` decide how this is written, both measured
 * against 4.12.0 (chant #1648):
 *
 * - `type: "success"` means validation *ran*, not that it passed. The findings
 *   are in `validationErrors`, and a check written as `if (answer.type ===
 *   "failure")` passes every type error in the corpus. `validatePolicySet`
 *   asserts `success && validationErrors.length === 0`.
 * - `validationErrors` comes back in a different order almost every call — the
 *   validator parallelizes across policies and does not re-sort. Forty
 *   identical calls produced six orderings. `validatePolicySet` sorts by
 *   `policyId` then message, so this check's output is stable enough to assert
 *   on.
 *
 * When the build emits no schema there is nothing to validate against, and
 * `validate()` cannot be called at all — it has no optional-schema mode, and an
 * empty schema is legal Cedar that reports every policy as inapplicable, which
 * would be worse than useless. Schema-driven codegen is #1650; until a schema
 * is emitted beside the policies, this check says so once, as an advisory,
 * rather than passing silently and claiming a guarantee it did not check.
 * CEDC010's parse gate still applies in that state.
 */
import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parsedPolicySets } from "./cedar-helpers";
import { findSchema, loadWasm, normalizePolicySet, validatePolicySet } from "./wasm-helpers";

export const cede010: PostSynthCheck = {
  id: "CEDE010",
  description: "Every emitted Cedar policy set validates clean against the project schema (cedar-wasm validate)",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    const sets = parsedPolicySets(ctx);
    if (sets.length === 0) return diagnostics;

    // A missing validator is CEDC010's finding to report, not this one's.
    const wasm = loadWasm();
    if (!wasm) return diagnostics;

    const schema = findSchema(ctx);
    if (!schema) {
      return [
        {
          checkId: "CEDE010",
          severity: "info",
          message: `No Cedar schema was emitted with the ${sets.length} policy set(s) in this build, so they were checked for parseability only — nothing verified that the entity types, actions, and attributes they name exist. Emit a .cedarschema (or .cedarschema.json) alongside the policies to turn this into real validation.`,
          lexicon: sets[0].lexicon,
        },
      ];
    }

    for (const set of sets) {
      const { policySet } = normalizePolicySet(wasm, set);
      const outcome = validatePolicySet(wasm, policySet, schema.schema);

      if (outcome.failure) {
        diagnostics.push({
          checkId: "CEDE010",
          severity: "error",
          message: `Cedar policy set "${set.source}" could not be validated against "${schema.source}": ${outcome.failure}`,
          entity: set.source,
          lexicon: set.lexicon,
        });
        continue;
      }

      for (const finding of outcome.errors) {
        diagnostics.push({
          checkId: "CEDE010",
          severity: "error",
          message: `Policy "${finding.policyId}" fails Cedar validation against "${schema.source}": ${finding.message}`,
          entity: finding.policyId,
          lexicon: set.lexicon,
        });
      }
    }

    return diagnostics;
  },
};
