/**
 * OTEL113: Pipelines form a cycle through connectors
 *
 * A connector carries data from the pipeline that lists it as an exporter to the pipeline that lists it as a receiver. When those hops lead back to a pipeline already on the path (traces/a feeds traces/b through one connector and traces/b feeds traces/a through another, or one pipeline lists the same `forward` connector on both sides), the collector refuses to start. The check walks the `edges` `collectorTopology()` returns and names one cycle per group of pipelines caught in it.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { configDiagnostics } from "./otel-helpers";

export const otel113: PostSynthCheck = {
  id: "OTEL113",
  description: "Pipelines form a cycle through connectors",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return configDiagnostics(ctx, "OTEL113");
  },
};
