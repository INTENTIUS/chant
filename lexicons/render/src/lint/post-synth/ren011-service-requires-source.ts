/**
 * REN011: A service needs a source — a repo or an image.
 *
 * Every Render service is either git-backed (`repo`, built on Render) or
 * image-backed (`image.imagePath`, pulled from a registry). One that names
 * neither has nothing to deploy and is rejected at create time; one that uses
 * the `image` runtime without an `image` is the same mistake spelled
 * differently. Static sites are always git-backed.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { readProps, isService, kindOf } from "./render-helpers";

export const ren011: PostSynthCheck = {
  id: "REN011",
  description: "A service must have a repo (git-backed) or an image (image-backed)",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [name, entity] of ctx.entities) {
      if (!isService(entity)) continue;
      const props = readProps(entity);
      const repo = typeof props.repo === "string" && props.repo.length > 0;
      const imagePath = readProps(props.image).imagePath;
      const image = typeof imagePath === "string" && imagePath.length > 0;
      const runtime = readProps(props.serviceDetails).runtime;

      if (!repo && !image) {
        diagnostics.push({
          checkId: "REN011",
          severity: "error",
          message: `${kindOf(entity)} "${name}" has neither a repo nor an image — set repo: "https://github.com/…" or image: new Image({ imagePath: "docker.io/…" })`,
          entity: name,
          lexicon: "render",
        });
      } else if (runtime === "image" && !image) {
        diagnostics.push({
          checkId: "REN011",
          severity: "error",
          message: `${kindOf(entity)} "${name}" uses runtime "image" but sets no image.imagePath`,
          entity: name,
          lexicon: "render",
        });
      }
    }

    return diagnostics;
  },
};
