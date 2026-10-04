/**
 * OTEL125: A pipeline sends to a remote otlp or otlphttp exporter without batching
 *
 * No `batch` processor in the pipeline, and the `otlp` or `otlphttp` exporter (non-loopback endpoint) sets no `sending_queue.batch`. At v0.130.0 neither exporter batches by default, so each small request goes out on its own. Other exporters may batch themselves and are not checked.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { configDiagnostics } from "./otel-helpers";

export const otel125: PostSynthCheck = {
  id: "OTEL125",
  description: "A pipeline sends to a remote otlp or otlphttp exporter without batching",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return configDiagnostics(ctx, "OTEL125");
  },
};
