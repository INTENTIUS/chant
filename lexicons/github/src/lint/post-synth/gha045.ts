/**
 * GHA045: Secret Interpolated Directly into a Shell Command
 *
 * Flags `${{ secrets.* }}` expanded straight into a `run:` script. The value is
 * substituted into the command line before the shell runs, where a transform
 * (base64, reversing, splitting) can defeat GitHub's log masking and leak it,
 * and the raw value is exposed to argument-injection. Pass secrets through an
 * `env:` variable and reference "$VAR" quoted instead.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractRunBlocks, extractExpressions } from "./yaml-helpers";

export const gha045: PostSynthCheck = {
  id: "GHA045",
  description: "Secret interpolated directly into a run: shell command",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      for (const { job, run } of extractRunBlocks(yaml)) {
        const leaked = extractExpressions(run).some((e) => /\bsecrets\./.test(e));
        if (!leaked) continue;
        diagnostics.push({
          checkId: "GHA045",
          severity: "warning",
          message: `Job "${job}" interpolates a secret directly into a run: script, where a transform can defeat log masking. Pass it through an env: variable and reference "$VAR" quoted instead.`,
          entity: job,
          lexicon: "github",
        });
      }
    }

    return diagnostics;
  },
};
