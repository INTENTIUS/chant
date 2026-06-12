/**
 * WGL031: Container Image Without an Immutable Digest
 *
 * Flags `image:` and `services:` references that are not pinned to an immutable
 * `@sha256:` digest. A mutable tag can be repointed to a different image after
 * review. Images built from a variable (e.g. `$CI_REGISTRY_IMAGE:tag`) are
 * skipped — their concrete reference is not knowable from the static config.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractImageRefs } from "./yaml-helpers";

export const wgl031: PostSynthCheck = {
  id: "WGL031",
  description: "Container image not pinned to an immutable digest",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      for (const { job, image, source } of extractImageRefs(yaml)) {
        if (image.includes("@sha256:")) continue;
        if (image.includes("$")) continue; // variable-based reference — not statically knowable
        diagnostics.push({
          checkId: "WGL031",
          severity: "warning",
          message: `Job "${job}" ${source === "service" ? "service image" : "image"} "${image}" is not pinned to a digest — reference it by @sha256:... so the image cannot change after review.`,
          entity: job,
          lexicon: "gitlab",
        });
      }
    }

    return diagnostics;
  },
};
