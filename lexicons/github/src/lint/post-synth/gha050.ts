/**
 * GHA050: Cache Populated in a Privileged Context (Poisoning Risk)
 *
 * Flags `actions/cache` use under a privileged trigger (`pull_request_target`,
 * `workflow_run`) that runs in the base-repo context. Cache entries written from
 * code influenced by a fork can later be restored by a trusted run and executed,
 * a cache-poisoning path. Restrict caching to trusted triggers or scope keys so
 * untrusted runs cannot write entries a privileged run will restore.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractTriggers, linesByJob } from "./yaml-helpers";

const PRIVILEGED_TRIGGERS = ["pull_request_target", "workflow_run"];

export const gha050: PostSynthCheck = {
  id: "GHA050",
  description: "Cache populated in a privileged context (poisoning risk)",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      const triggers = extractTriggers(yaml);
      const privileged = PRIVILEGED_TRIGGERS.filter((t) => triggers[t]);
      if (privileged.length === 0) continue;

      for (const [job, lines] of linesByJob(yaml)) {
        if (lines.some((l) => /uses:\s*actions\/cache/.test(l))) {
          diagnostics.push({
            checkId: "GHA050",
            severity: "warning",
            message: `Job "${job}" populates a cache under the ${privileged.join("/")} trigger, which runs in the privileged base context. A poisoned cache entry could be restored and executed by a trusted run — restrict caching to trusted triggers.`,
            entity: job,
            lexicon: "github",
          });
        }
      }
    }

    return diagnostics;
  },
};
