/**
 * GHA039: Spoofable Identity Used as an Authorization Gate
 *
 * Flags an `if:` condition that gates execution on a commit-author identity
 * field (`...author.name` / `...author.email`). Those values come straight from
 * git metadata the committer sets freely, so an attacker can forge them to pass
 * the gate. Use a trustworthy signal — environment protection rules, CODEOWNERS,
 * or membership checks against a verified actor.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractIfConditions } from "./yaml-helpers";

const SPOOFABLE_FIELD_RE = /\.author\.(name|email)\b/;
const COMPARISON_RE = /==|!=|contains\s*\(/;

export const gha039: PostSynthCheck = {
  id: "GHA039",
  description: "Authorization gate on a spoofable commit-author identity field",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      for (const { job, expr } of extractIfConditions(yaml)) {
        if (SPOOFABLE_FIELD_RE.test(expr) && COMPARISON_RE.test(expr)) {
          diagnostics.push({
            checkId: "GHA039",
            severity: "warning",
            message: `Job "${job}" gates on a commit-author identity field in an if: condition (${expr}). Author name/email are attacker-controlled and can be spoofed — gate on a verified signal (environment protection, CODEOWNERS, verified actor) instead.`,
            entity: job,
            lexicon: "github",
          });
        }
      }
    }

    return diagnostics;
  },
};
