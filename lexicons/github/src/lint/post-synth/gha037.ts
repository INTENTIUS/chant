/**
 * GHA037: Untrusted Input Written to GITHUB_ENV / GITHUB_PATH
 *
 * Flags a `run:` step that writes attacker-controllable input into the
 * `$GITHUB_ENV` or `$GITHUB_PATH` files. Those files set environment variables
 * and PATH entries for *later* steps, so injecting into them escalates a data
 * value into influence over subsequent privileged steps (a known path to
 * `LD_PRELOAD`/`NODE_OPTIONS`-style takeover).
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractRunBlocks, extractExpressions } from "./yaml-helpers";
import { matchUntrustedContext } from "../rules/data/untrusted-contexts";

const ENV_FILE_RE = /GITHUB_ENV|GITHUB_PATH/;

export const gha037: PostSynthCheck = {
  id: "GHA037",
  description: "Untrusted input written to GITHUB_ENV / GITHUB_PATH",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      for (const { job, run } of extractRunBlocks(yaml)) {
        if (!ENV_FILE_RE.test(run)) continue;
        for (const expr of extractExpressions(run)) {
          const ctxName = matchUntrustedContext(expr);
          if (!ctxName) continue;
          const file = run.includes("GITHUB_PATH") ? "GITHUB_PATH" : "GITHUB_ENV";
          diagnostics.push({
            checkId: "GHA037",
            severity: "error",
            message: `Job "${job}" writes untrusted input \${{ ${ctxName} ... }} into $${file}, which sets state for later steps. Sanitize/validate the value or avoid persisting untrusted input across steps.`,
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
