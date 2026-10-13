/**
 * OTEL102: A pipeline has no receivers or no exporters
 *
 * A pipeline with no receivers takes in nothing, and one with no exporters sends what it takes in nowhere. The collector rejects both at start.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { configDiagnostics } from "./otel-helpers";

export const otel102: PostSynthCheck = {
  id: "OTEL102",
  description: "A pipeline has no receivers or no exporters",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return configDiagnostics(ctx, "OTEL102");
  },
};
