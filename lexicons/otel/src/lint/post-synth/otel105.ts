/**
 * OTEL105: memory_limiter is not the first processor in a pipeline
 *
 * The collector's own guidance puts memory_limiter first, so it can refuse data before any other processor buffers it. Later in the chain it limits too late to protect the process.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { configDiagnostics } from "./otel-helpers";

export const otel105: PostSynthCheck = {
  id: "OTEL105",
  description: "memory_limiter is not the first processor in a pipeline",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return configDiagnostics(ctx, "OTEL105");
  },
};
