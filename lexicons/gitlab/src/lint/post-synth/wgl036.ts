/**
 * WGL036: Privileged Service / Docker-in-Docker Reachable from Merge Requests
 *
 * Flags a job that uses Docker-in-Docker (a privileged service) and is reachable
 * from merge-request pipelines. MR pipelines can run code from an outside
 * contributor; a privileged DinD service shares the host daemon socket and can
 * be used to escape the build and reach the runner. Restrict privileged services
 * to protected refs, or require approval before such jobs run.
 *
 * Complements WGL026 (DinD without TLS) by adding the trust-boundary dimension.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractJobs, extractJobSection, isMergeRequestReachable } from "./yaml-helpers";

const DIND_RE = /docker:[\w.-]*dind|dind|privileged:\s*true/;

export const wgl036: PostSynthCheck = {
  id: "WGL036",
  description: "Privileged service / DinD reachable from merge-request pipelines",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      for (const [job] of extractJobs(yaml)) {
        const section = extractJobSection(yaml, job);
        if (!section) continue;
        if (DIND_RE.test(section) && isMergeRequestReachable(section)) {
          diagnostics.push({
            checkId: "WGL036",
            severity: "warning",
            message: `Job "${job}" runs a privileged Docker-in-Docker service and is reachable from merge-request pipelines, which outside contributors can trigger. Restrict privileged services to protected refs or require approval.`,
            entity: job,
            lexicon: "gitlab",
          });
        }
      }
    }

    return diagnostics;
  },
};
