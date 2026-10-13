/**
 * PROM301: A rule reads a connector metric no collector in the build emits
 *
 * For each selector in a rule whose name falls under a namespace the build's
 * spanmetrics, servicegraph or GenAI connectors own (spanmetrics' and
 * servicegraph's defaults included), reports a name no collector config in
 * the build emits, and a by (...) label that is not a dimension the config
 * declares for the metrics aggregated. Silent for names outside those
 * namespaces, and when the build has no collector config. See
 * ../../collector-metrics.ts.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { collectorMetricDiagnostics } from "./prom-helpers";

export const prom301: PostSynthCheck = {
  id: "PROM301",
  description: "A rule reads a connector metric no collector in the build emits",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return collectorMetricDiagnostics(ctx);
  },
};
