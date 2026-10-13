/**
 * OTEL117: Two components the collector starts listen on the same address
 *
 * A receiver or exporter a pipeline lists, an extension in `service.extensions`, and the collector's own metrics endpoint (`localhost:8888` unless `service.telemetry.metrics` says otherwise) each bind an address when the collector starts. Two on the same port, on the same host or with either on a wildcard host (`0.0.0.0`, `::`), make the second bind fail with "address already in use", and the collector exits. `otelcol validate` does not bind, so it accepts such a config. The listeners checked are the otlp, zipkin and jaeger receivers, the prometheus exporter, and the health_check, zpages and pprof extensions, with their defaults at the pinned collector release.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { configDiagnostics } from "./otel-helpers";

export const otel117: PostSynthCheck = {
  id: "OTEL117",
  description: "Two components the collector starts listen on the same address",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return configDiagnostics(ctx, "OTEL117");
  },
};
