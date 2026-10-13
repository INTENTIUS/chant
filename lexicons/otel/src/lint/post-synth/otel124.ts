/**
 * OTEL124: A remote exporter has its sending queue or retries turned off
 *
 * A started exporter with a non-loopback endpoint and `sending_queue.enabled: false` blocks the pipeline when the backend is slow; with `retry_on_failure.enabled: false` it drops a failed request's data.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { configDiagnostics } from "./otel-helpers";

export const otel124: PostSynthCheck = {
  id: "OTEL124",
  description: "A remote exporter has its sending queue or retries turned off",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return configDiagnostics(ctx, "OTEL124");
  },
};
