/**
 * SLR013: AuthType must be auth/munge
 *
 * AuthType=auth/none disables authentication entirely — any user can
 * submit jobs as any other user. This is dangerous in any multi-user
 * environment. Munge is the standard Slurm auth mechanism.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";

export const slr013: PostSynthCheck = {
  id: "SLR013",
  description: "AuthType=auth/none disables Slurm authentication and is unsafe",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [lexicon, output] of ctx.outputs) {
      if (lexicon !== "slurm") continue;
      const content = typeof output === "string" ? output : output.primary;

      if (/^AuthType=auth\/none/m.test(content)) {
        diagnostics.push({
          checkId: "SLR013",
          severity: "error",
          message: "AuthType=auth/none disables authentication — use AuthType=auth/munge",
          lexicon: "slurm",
        });
      }
    }

    return diagnostics;
  },
};
