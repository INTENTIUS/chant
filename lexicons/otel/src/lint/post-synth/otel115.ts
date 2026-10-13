/**
 * OTEL115: A routing connector routes to a pipeline that does not receive from it
 *
 * Every pipeline a `routing` connector names in `table[].pipelines` or `default_pipelines` must list that connector in its receivers. The connector can only hand data to the pipelines it feeds, and the collector refuses to start when a route names any other pipeline or one that does not exist.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { configDiagnostics } from "./otel-helpers";

export const otel115: PostSynthCheck = {
  id: "OTEL115",
  description: "A routing connector routes to a pipeline that does not receive from it",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return configDiagnostics(ctx, "OTEL115");
  },
};
