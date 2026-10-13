/**
 * OTEL108: Two components or two pipelines declare the same id
 *
 * The collector config is keyed by id, so the second declaration would silently replace the first. The serializer keeps the first and this check fails the build.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { entityDiagnostics } from "./otel-helpers";

export const otel108: PostSynthCheck = {
  id: "OTEL108",
  description: "Two components or two pipelines declare the same id",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return entityDiagnostics(ctx, "OTEL108");
  },
};
