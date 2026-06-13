/**
 * WGL042: Unreachable rules After an Unconditional Match
 *
 * GitLab evaluates `rules:` top-down and the first match wins. A rule with no
 * `if:` (and not `when: never`) matches every pipeline, so any rule listed after
 * it is dead — it can never be reached. Such dead rules usually mean the gate
 * the author intended is not actually applied. Reorder so specific rules precede
 * the catch-all.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractJobs, extractJobSection, extractJobRules } from "./yaml-helpers";

export const wgl042: PostSynthCheck = {
  id: "WGL042",
  description: "Unreachable rules after an unconditional match",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      for (const [job] of extractJobs(yaml)) {
        const section = extractJobSection(yaml, job);
        if (!section) continue;
        const rules = extractJobRules(section);
        for (let i = 0; i < rules.length - 1; i++) {
          const r = rules[i];
          const unconditional = !r.if && r.when !== "never";
          if (unconditional) {
            diagnostics.push({
              checkId: "WGL042",
              severity: "warning",
              message: `Job "${job}" has an unconditional rule at position ${i + 1} that matches every pipeline, making the ${rules.length - i - 1} rule(s) after it unreachable. Put specific rules before the catch-all.`,
              entity: job,
              lexicon: "gitlab",
            });
            break;
          }
        }
      }
    }

    return diagnostics;
  },
};
