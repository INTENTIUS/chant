/**
 * WGL046: Cache Populated in a Merge-Request Pipeline (Poisoning Risk)
 *
 * Flags a job that writes a cache (`cache:` with a push policy) and is reachable
 * from merge-request pipelines. An outside contributor's MR can populate the
 * cache; a later protected run that restores the same key then executes
 * attacker-influenced contents. Restrict cache writes to protected refs, or
 * scope cache keys so MR pipelines cannot write entries a protected run reads.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractJobs, extractJobSection, isMergeRequestReachable } from "./yaml-helpers";

export const wgl046: PostSynthCheck = {
  id: "WGL046",
  description: "Cache populated in a merge-request pipeline (poisoning risk)",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      for (const [job] of extractJobs(yaml)) {
        const section = extractJobSection(yaml, job);
        if (!section || !/^\s+cache:/m.test(section)) continue;
        if (!isMergeRequestReachable(section)) continue;
        // pull-only caches cannot poison; flag push/pull-push (the default when policy is absent)
        const policyMatch = section.match(/^\s+policy:\s*(\S+)/m);
        const policy = policyMatch ? policyMatch[1].replace(/^['"]|['"]$/g, "") : "pull-push";
        if (policy === "pull") continue;
        diagnostics.push({
          checkId: "WGL046",
          severity: "warning",
          message: `Job "${job}" writes a cache and is reachable from merge-request pipelines. An MR can poison the cache for a later protected run that restores the same key — restrict cache writes to protected refs or scope the key.`,
          entity: job,
          lexicon: "gitlab",
        });
      }
    }

    return diagnostics;
  },
};
