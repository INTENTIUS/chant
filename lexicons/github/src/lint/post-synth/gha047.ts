/**
 * GHA047: Ineffective `contains()` Guard (Reversed Arguments)
 *
 * Flags `contains('literal', <dynamic>)` — a string literal as the haystack and
 * a dynamic value as the needle. `contains(search, item)` checks whether `item`
 * is in `search`, so a constant first argument makes the result depend on a
 * fixed string rather than the runtime value the author intended to test. The
 * usual fix is to swap the arguments.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractIfConditions } from "./yaml-helpers";

// contains( 'literal' | "literal" , <something that is not a literal> )
const REVERSED_CONTAINS = /contains\(\s*(['"][^'"]*['"])\s*,\s*([^)]+)\)/g;

function isLiteral(arg: string): boolean {
  const t = arg.trim();
  return (t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'));
}

export const gha047: PostSynthCheck = {
  id: "GHA047",
  description: "Ineffective contains() guard with reversed arguments",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      for (const { job, expr } of extractIfConditions(yaml)) {
        let m: RegExpExecArray | null;
        REVERSED_CONTAINS.lastIndex = 0;
        while ((m = REVERSED_CONTAINS.exec(expr)) !== null) {
          // First arg is a literal; flag only when the second arg is dynamic.
          if (isLiteral(m[2])) continue;
          diagnostics.push({
            checkId: "GHA047",
            severity: "warning",
            message: `Job "${job}" calls contains() with a string-literal haystack and a dynamic needle: "${m[0]}". contains(search, item) tests whether item is in search — swap the arguments so the dynamic value is searched.`,
            entity: job,
            lexicon: "github",
          });
          break;
        }
      }
    }

    return diagnostics;
  },
};
