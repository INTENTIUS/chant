/**
 * OTEL127: resourcedetection lists a detector that does not exist
 *
 * Each name in a started `resourcedetection` processor's `detectors` must be one the processor registers at collector-contrib v0.130.0 (`RESOURCE_DETECTORS`); any other fails the processor's build and the collector exits.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { configDiagnostics } from "./otel-helpers";

export const otel127: PostSynthCheck = {
  id: "OTEL127",
  description: "resourcedetection lists a detector that does not exist",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return configDiagnostics(ctx, "OTEL127");
  },
};
