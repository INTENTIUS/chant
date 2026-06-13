/**
 * WGL034: OIDC id_token Mintable from a Merge-Request Pipeline
 *
 * Flags a job that declares an `id_tokens:` (OIDC) and is reachable from
 * merge-request pipelines. MR pipelines can be triggered by outside
 * contributors, so a job that mints a cloud-federated token there hands fork
 * code a path to your cloud roles. Gate OIDC jobs to protected refs, or require
 * approval before they run.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractIdTokens, extractJobSection, isMergeRequestReachable } from "./yaml-helpers";

export const wgl034: PostSynthCheck = {
  id: "WGL034",
  description: "OIDC id_token mintable from a merge-request pipeline",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      const seen = new Set<string>();
      for (const { job } of extractIdTokens(yaml)) {
        if (seen.has(job)) continue;
        const section = extractJobSection(yaml, job);
        if (section && isMergeRequestReachable(section)) {
          seen.add(job);
          diagnostics.push({
            checkId: "WGL034",
            severity: "warning",
            message: `Job "${job}" mints an OIDC id_token and is reachable from merge-request pipelines, which outside contributors can trigger. Restrict it to protected refs or require approval before it runs.`,
            entity: job,
            lexicon: "gitlab",
          });
        }
      }
    }

    return diagnostics;
  },
};
