/**
 * FLY010: Machine config must specify an image.
 *
 * A Machine cannot boot without a container image. The Machines API rejects a
 * create request whose config omits `image`, so catch it at synth time with a
 * clearer message.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { readProps, entityTypeOf } from "./fly-helpers";

export const fly010: PostSynthCheck = {
  id: "FLY010",
  description: "Machine config must specify an image — a Machine cannot boot without one",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [name, entity] of ctx.entities) {
      if (entityTypeOf(entity) !== "Fly::Machines::Machine") continue;

      const config = readProps(entity).config;
      if (!config) continue; // no config authored — a different concern

      const image = readProps(config).image;
      if (typeof image !== "string" || image.length === 0) {
        diagnostics.push({
          checkId: "FLY010",
          severity: "error",
          message: `Machine "${name}" config has no image — set config.image, e.g. image: "flyio/fastify-functions"`,
          entity: name,
          lexicon: "fly",
        });
      }
    }

    return diagnostics;
  },
};
