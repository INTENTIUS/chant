/**
 * GHA048: Obfuscated Guard Condition
 *
 * Flags an `if:` condition that builds its compared value through string
 * indirection — `format()`, `join()`, or `fromJSON()` feeding a comparison.
 * Constructing the operand at evaluation time hides what the gate actually
 * checks, which is how an unsound condition (GHA046/GHA047) is disguised to pass
 * review. Write the comparison against the value directly.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractIfConditions } from "./yaml-helpers";

const INDIRECTION = /\b(format|join|fromJSON)\s*\(/i;
const COMPARISON = /==|!=|&&|\|\||contains\(|startsWith\(|endsWith\(/;

export const gha048: PostSynthCheck = {
  id: "GHA048",
  description: "Obfuscated guard condition (operand built by indirection)",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      for (const { job, expr } of extractIfConditions(yaml)) {
        if (INDIRECTION.test(expr) && COMPARISON.test(expr)) {
          diagnostics.push({
            checkId: "GHA048",
            severity: "warning",
            message: `Job "${job}" builds its if: gate through string indirection (format/join/fromJSON) feeding a comparison: "${expr}". Compare against the value directly so the condition is auditable.`,
            entity: job,
            lexicon: "github",
          });
        }
      }
    }

    return diagnostics;
  },
};
