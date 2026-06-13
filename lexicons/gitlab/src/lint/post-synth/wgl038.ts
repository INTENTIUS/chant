/**
 * WGL038: Secret Reachable from a Merge-Request Pipeline
 *
 * Flags a user-defined secret-like variable (`*_PASSWORD`, `*_SECRET`,
 * `*_TOKEN`, `*_API_KEY`, …) referenced in a job reachable from merge-request
 * pipelines. Those pipelines can run an outside contributor's code, so a secret
 * they can read is a secret they can exfiltrate. Gate secret-using jobs to
 * protected refs, or make the variable protected so MR pipelines can't see it.
 *
 * Built-in `CI_*` variables are project-managed and excluded.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractJobs, extractJobSection, isMergeRequestReachable } from "./yaml-helpers";

const SECRET_VAR = /\$\{?((?!CI_)[A-Z][A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|API[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIALS?))\}?/g;

export const wgl038: PostSynthCheck = {
  id: "WGL038",
  description: "Secret-like variable reachable from a merge-request pipeline",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      for (const [job] of extractJobs(yaml)) {
        const section = extractJobSection(yaml, job);
        if (!section || !isMergeRequestReachable(section)) continue;
        const found = new Set<string>();
        let m: RegExpExecArray | null;
        SECRET_VAR.lastIndex = 0;
        while ((m = SECRET_VAR.exec(section)) !== null) found.add(m[1]);
        if (found.size > 0) {
          diagnostics.push({
            checkId: "WGL038",
            severity: "warning",
            message: `Job "${job}" reads secret-like variable(s) ${[...found].map((v) => `$${v}`).join(", ")} and is reachable from merge-request pipelines, which can run untrusted code. Gate it to protected refs or mark the variable protected.`,
            entity: job,
            lexicon: "gitlab",
          });
        }
      }
    }

    return diagnostics;
  },
};
