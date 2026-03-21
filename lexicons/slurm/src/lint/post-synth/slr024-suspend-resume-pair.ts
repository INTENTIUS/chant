/**
 * SLR024: SuspendProgram and ResumeProgram must be set together
 *
 * SuspendProgram without ResumeProgram means nodes will be suspended but
 * can never be resumed — new jobs will sit in queue indefinitely. The reverse
 * (ResumeProgram without SuspendProgram) means nodes are never suspended,
 * negating the power savings benefit. Both must be set together.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";

export const slr024: PostSynthCheck = {
  id: "SLR024",
  description: "SuspendProgram and ResumeProgram must both be set or both be absent",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [lexicon, output] of ctx.outputs) {
      if (lexicon !== "slurm") continue;
      const content = typeof output === "string" ? output : output.primary;

      const hasSuspend = /^SuspendProgram=/m.test(content);
      const hasResume = /^ResumeProgram=/m.test(content);

      if (hasSuspend && !hasResume) {
        diagnostics.push({
          checkId: "SLR024",
          severity: "error",
          message: "SuspendProgram is set but ResumeProgram is missing — nodes will suspend but never resume",
          lexicon: "slurm",
        });
      } else if (hasResume && !hasSuspend) {
        diagnostics.push({
          checkId: "SLR024",
          severity: "warning",
          message: "ResumeProgram is set but SuspendProgram is missing — nodes will never be suspended",
          lexicon: "slurm",
        });
      }
    }

    return diagnostics;
  },
};
