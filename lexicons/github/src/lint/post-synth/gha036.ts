/**
 * GHA036: Untrusted Input Interpolated into a Shell Command
 *
 * Flags attacker-controllable expression contexts (PR titles, branch names,
 * issue/comment bodies, commit messages) interpolated directly into a `run:`
 * script. The value is expanded into the shell before the script runs, so a
 * crafted payload becomes command execution. Pass untrusted input through an
 * `env:` variable and reference it quoted instead.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractRunBlocks, extractExpressions } from "./yaml-helpers";
import { matchUntrustedContext } from "../rules/data/untrusted-contexts";

export const gha036: PostSynthCheck = {
  id: "GHA036",
  description: "Untrusted input interpolated into a run: shell command",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      for (const { job, run } of extractRunBlocks(yaml)) {
        for (const expr of extractExpressions(run)) {
          const ctxName = matchUntrustedContext(expr);
          if (!ctxName) continue;
          diagnostics.push({
            checkId: "GHA036",
            severity: "error",
            message: `Job "${job}" interpolates untrusted input \${{ ${ctxName} ... }} into a run: script — this is a script-injection sink. Pass it through an env: variable and reference "$VAR" quoted instead.`,
            entity: job,
            lexicon: "github",
          });
          break; // one diagnostic per run block is enough
        }
      }
    }

    return diagnostics;
  },
};
