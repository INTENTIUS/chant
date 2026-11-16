/**
 * PROW104: a presubmit that mounts a credential.
 *
 * A presubmit runs a pull request's code, which its author wrote, so a
 * Secret its pod reads (a secret volume, an environment variable from a
 * Secret's key, or a container's envFrom of a Secret) is open to that code.
 * Prow runs a presubmit for anyone its trigger trusts, and `/ok-to-test`
 * extends that to anyone a member vouches for. Keep the credential in a
 * postsubmit or a periodic, which run merged code, or drop it from the
 * environment before the change's code runs and say so in the job.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { builtJobConfigs, nameOf, secretMounts } from "./prow-helpers";

export const prow104: PostSynthCheck = {
  id: "PROW104",
  description: "A presubmit whose pod reads a Secret, which the pull request's code can read too",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const out: PostSynthDiagnostic[] = [];
    for (const { source, jobs } of builtJobConfigs(ctx)) {
      for (const j of jobs) {
        if (j.type !== "presubmit") continue;
        const mounts = secretMounts(j.job);
        if (mounts.length === 0) continue;
        out.push({
          checkId: "PROW104",
          severity: "warning",
          message: `${source}: presubmit ${nameOf(j)} on ${j.repo} reads ${mounts.join(", ")}. A presubmit runs the pull request's code, so that code can read the credential; move it to a postsubmit or a periodic, or keep it out of the change's process.`,
          entity: nameOf(j),
          lexicon: "prow",
        });
      }
    }
    return out;
  },
};
