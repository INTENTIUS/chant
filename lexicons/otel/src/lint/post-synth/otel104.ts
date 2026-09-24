/**
 * OTEL104: service.extensions enables an extension that is not declared
 *
 * The collector refuses to start when service.extensions names an id with no entry under extensions.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { configDiagnostics } from "./otel-helpers";

export const otel104: PostSynthCheck = {
  id: "OTEL104",
  description: "service.extensions enables an extension that is not declared",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return configDiagnostics(ctx, "OTEL104");
  },
};
