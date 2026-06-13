/**
 * WGL043: Match-Anything Regex Gate
 *
 * Flags a `rules:if` whose regex match (`=~`) uses a pattern that matches every
 * value — an empty regex, dot-star, or an anchored dot-star. The condition reads
 * like a filter on a ref or variable but admits everything, so it gates nothing.
 * This is how an unsound condition is obscured behind a regex. Tighten the
 * pattern or remove the gate.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractJobs, extractJobSection, extractJobRules } from "./yaml-helpers";

// `=~` followed by a regex literal that matches anything.
const MATCH_ANYTHING = /=~\s*\/(?:|\.\*|\^\.\*\$|\^\.\*|\.\*\$)\//;

export const wgl043: PostSynthCheck = {
  id: "WGL043",
  description: "Match-anything regex gate in rules:if",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      for (const [job] of extractJobs(yaml)) {
        const section = extractJobSection(yaml, job);
        if (!section) continue;
        for (const rule of extractJobRules(section)) {
          if (rule.if && MATCH_ANYTHING.test(rule.if)) {
            diagnostics.push({
              checkId: "WGL043",
              severity: "warning",
              message: `Job "${job}" gates on a regex that matches everything ("${rule.if}") — the rule reads like a filter but admits every value. Tighten the pattern or remove the gate.`,
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
