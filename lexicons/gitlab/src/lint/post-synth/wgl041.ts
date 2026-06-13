/**
 * WGL041: Logically Unsound rules:if Condition
 *
 * Flags a `rules:if` that reads like a gate but is a constant — both sides of an
 * `==`/`!=` are identical, so the condition is always true or always false.
 * Generalizes WGL011 (rules that always evaluate to never) to tautological
 * conditions presented as gates.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractJobs, extractJobSection, extractJobRules } from "./yaml-helpers";

function strip(s: string): string {
  return s.trim().replace(/^['"]|['"]$/g, "").trim();
}

/** Classify an `if:` expression as a tautology, returning a reason or undefined. */
export function tautologyReason(expr: string): string | undefined {
  const e = strip(expr).replace(/^\$\{?/, "$").trim();
  const eq = e.match(/^(\S.*?)\s*==\s*(\S.*?)$/);
  if (eq && strip(eq[1]) === strip(eq[2])) return "always true (both sides of == are identical)";
  const ne = e.match(/^(\S.*?)\s*!=\s*(\S.*?)$/);
  if (ne && strip(ne[1]) === strip(ne[2])) return "always false (both sides of != are identical)";
  return undefined;
}

export const wgl041: PostSynthCheck = {
  id: "WGL041",
  description: "Logically unsound (tautological) rules:if condition",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      for (const [job] of extractJobs(yaml)) {
        const section = extractJobSection(yaml, job);
        if (!section) continue;
        for (const rule of extractJobRules(section)) {
          if (!rule.if) continue;
          const reason = tautologyReason(rule.if);
          if (reason) {
            diagnostics.push({
              checkId: "WGL041",
              severity: "warning",
              message: `Job "${job}" has a rules:if that is ${reason}: "${rule.if}". A gate that does not constrain anything is misleading — write the real condition or remove it.`,
              entity: job,
              lexicon: "gitlab",
            });
          }
        }
      }
    }

    return diagnostics;
  },
};
