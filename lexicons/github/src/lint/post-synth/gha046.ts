/**
 * GHA046: Logically Unsound Guard Condition
 *
 * Flags an `if:` condition that reads like a security/flow gate but evaluates to
 * a constant — `true`/`false` literals, an `X == X` tautology, or an expression
 * that collapses via `|| true` / `&& false`. These pass review by looking like a
 * control while gating nothing (or everything).
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractIfConditions } from "./yaml-helpers";

/** Strip a leading `${{` / trailing `}}` wrapper from an expression. */
function inner(expr: string): string {
  return expr.replace(/^\$\{\{/, "").replace(/\}\}$/, "").trim();
}

/** Classify a condition as a constant guard, returning a reason or undefined. */
export function unsoundReason(expr: string): string | undefined {
  const e = inner(expr);
  if (e === "true") return "always true (true literal)";
  if (e === "false") return "always false (false literal)";
  if (/\|\|\s*true\b/.test(e)) return "always true (|| true collapses the condition)";
  if (/&&\s*false\b/.test(e)) return "always false (&& false collapses the condition)";
  const eq = e.match(/^([\w.$'"[\]-]+)\s*==\s*([\w.$'"[\]-]+)$/);
  if (eq && eq[1] === eq[2]) return "always true (both sides of == are identical)";
  const ne = e.match(/^([\w.$'"[\]-]+)\s*!=\s*([\w.$'"[\]-]+)$/);
  if (ne && ne[1] === ne[2]) return "always false (both sides of != are identical)";
  return undefined;
}

export const gha046: PostSynthCheck = {
  id: "GHA046",
  description: "Logically unsound (constant) guard condition",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      for (const { job, expr } of extractIfConditions(yaml)) {
        const reason = unsoundReason(expr);
        if (!reason) continue;
        diagnostics.push({
          checkId: "GHA046",
          severity: "warning",
          message: `Job "${job}" has an if: condition that is ${reason}: "${expr}". A gate that does not constrain anything is misleading — remove it or write the real condition.`,
          entity: job,
          lexicon: "github",
        });
      }
    }

    return diagnostics;
  },
};
