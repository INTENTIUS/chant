/**
 * GHA030: Container Image Without an Immutable Digest
 *
 * Flags job `container:` images, `services:` images, and `docker://` step
 * references that are not pinned to an immutable `@sha256:` digest. A mutable
 * tag (`:latest`, `:20`) can be repointed to a different image after review.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractImageRefs } from "./yaml-helpers";

const SOURCE_LABEL: Record<string, string> = {
  container: "container image",
  service: "service image",
  step: "docker:// image",
};

export const gha030: PostSynthCheck = {
  id: "GHA030",
  description: "Container image not pinned to an immutable digest",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      for (const { job, image, source } of extractImageRefs(yaml)) {
        if (image.includes("@sha256:")) continue;
        diagnostics.push({
          checkId: "GHA030",
          severity: "warning",
          message: `Job "${job}" ${SOURCE_LABEL[source]} "${image}" is not pinned to a digest — reference it by @sha256:... so the image cannot change after review.`,
          entity: job,
          lexicon: "github",
        });
      }
    }

    return diagnostics;
  },
};
