/**
 * GHA049: Persisted Checkout Credentials Reachable by an Uploaded Artifact
 *
 * `actions/checkout` writes the job token into `.git/config` by default
 * (`persist-credentials: true`). A job that also uploads an artifact can sweep
 * that `.git` directory into the artifact, leaking the token to anyone who can
 * download it. Set `persist-credentials: false` on the checkout when the job
 * uploads artifacts.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, linesByJob } from "./yaml-helpers";

export const gha049: PostSynthCheck = {
  id: "GHA049",
  description: "Persisted checkout credentials reachable by an uploaded artifact",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      for (const [job, lines] of linesByJob(yaml)) {
        const text = lines.join("\n");
        const hasCheckout = /uses:\s*actions\/checkout/.test(text);
        const persistDisabled = /persist-credentials:\s*false/.test(text);
        const uploadsArtifact = /uses:\s*actions\/upload-artifact/.test(text);
        if (hasCheckout && uploadsArtifact && !persistDisabled) {
          diagnostics.push({
            checkId: "GHA049",
            severity: "warning",
            message: `Job "${job}" checks out with persisted credentials (default) and uploads an artifact — the token in .git/config can leak into the artifact. Set persist-credentials: false on the checkout.`,
            entity: job,
            lexicon: "github",
          });
        }
      }
    }

    return diagnostics;
  },
};
