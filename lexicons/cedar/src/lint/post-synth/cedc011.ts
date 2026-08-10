/**
 * CEDC011: every `when`/`unless` condition expression must parse
 *
 * A policy's guard is the part that does the work — `when { context.mfa }`,
 * `unless { resource.public }` — and until schema-driven codegen (#1650) makes
 * those typed trees, the authored model carries them as Cedar expression
 * *source*. Source that does not parse turns into a policy no evaluator will
 * load, and the failure surfaces a long way from the typo: the whole policy set
 * is rejected, naming a byte offset in a generated file.
 *
 * So the clause is parsed on its own and reported on its own, with the
 * expression text and Cedar's own message (which carries a "did you mean"
 * suggestion often enough to be worth passing through).
 */
import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { CEDAR_LEXICON, parsedPolicySets } from "./cedar-helpers";
import { loadWasm, normalizePolicySet } from "./wasm-helpers";

export const cedc011: PostSynthCheck = {
  id: "CEDC011",
  description: "Every when/unless condition expression in an emitted policy must parse as a Cedar expression",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    const sets = parsedPolicySets(ctx);
    if (sets.length === 0) return diagnostics;

    // A missing validator is CEDC010's finding to report, not this one's.
    const wasm = loadWasm();
    if (!wasm) return diagnostics;

    for (const set of sets) {
      const { expressionFailures } = normalizePolicySet(wasm, set);
      for (const failure of expressionFailures) {
        diagnostics.push({
          checkId: "CEDC011",
          severity: "error",
          message: `Policy "${failure.key}" has a ${failure.kind} clause whose expression does not parse: ${failure.expression} — ${failure.message}`,
          entity: failure.key,
          lexicon: set.lexicon || CEDAR_LEXICON,
        });
      }
    }

    return diagnostics;
  },
};
