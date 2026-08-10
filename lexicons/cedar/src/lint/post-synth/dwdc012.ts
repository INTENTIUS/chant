/**
 * DWDC012: `formerly`, `previous` and `since` carry a mandatory window
 *
 * Upstream's grammar makes `within` non-optional on all three:
 *
 * ```
 * once_op     = { "formerly" ~ within ~ atom }
 * previous_op = { "previous" ~ within ~ atom }
 * conjunct_or_since = { neg_conjunct ~ ("since" ~ within ~ atom)? }
 * ```
 *
 * The typed builders make this unrepresentable — `formerly(window, body)` has
 * nowhere to put a missing window — which is most of the fix. This check is
 * the other part: `raw()` exists as an escape hatch, a hand-written `.dw` can
 * be built by any other tool, and `chant audit` runs over files chant never
 * emitted. A wall that only holds for the path that cannot breach it is not
 * a wall.
 */
import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { dogwoodPolicyFiles, scanWindowlessOperators } from "../../dogwood/scan";

export const dwdc012: PostSynthCheck = {
  id: "DWDC012",
  description: "A dogwood formerly/previous/since operator carries its mandatory within window",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const policies of dogwoodPolicyFiles(ctx)) {
      const seen = new Set<string>();
      for (const operator of scanWindowlessOperators(policies.text)) {
        if (seen.has(operator)) continue;
        seen.add(operator);
        diagnostics.push({
          checkId: "DWDC012",
          severity: "error",
          message: `Dogwood policy set "${policies.source}" uses \`${operator}\` with no \`within\` window. All three past-only operators require one — write \`${operator} within <n><s|m|h|d> …\`.`,
          entity: policies.source,
          lexicon: policies.lexicon,
        });
      }
    }

    return diagnostics;
  },
};
