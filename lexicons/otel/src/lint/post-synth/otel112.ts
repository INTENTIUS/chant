/**
 * OTEL112: A connector joins pipelines whose signals it does not convert
 *
 * Each connector supports fixed signal pairs: `spanmetrics` and `servicegraph` read traces and write metrics, `count` writes metrics from any signal, `routing` and `forward` keep the signal. Every pipeline that feeds a connector must pair with a pipeline it feeds through one of those pairs, and the other way round, or the collector refuses to start. A traces pipeline that receives from `spanmetrics` fails this check. Custom connectors are checked when their `defineComponent` call lists `connects`.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { configDiagnostics } from "./otel-helpers";

export const otel112: PostSynthCheck = {
  id: "OTEL112",
  description: "A connector joins pipelines whose signals it does not convert",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return configDiagnostics(ctx, "OTEL112");
  },
};
