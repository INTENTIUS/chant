/**
 * OTEL114: A connector id is also declared as a receiver or exporter
 *
 * A pipeline names a connector the same way it names a receiver or an exporter, so the collector refuses a config where a connector id is also declared under `receivers` or `exporters`, whether or not any pipeline uses it.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { configDiagnostics } from "./otel-helpers";

export const otel114: PostSynthCheck = {
  id: "OTEL114",
  description: "A connector id is also declared as a receiver or exporter",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return configDiagnostics(ctx, "OTEL114");
  },
};
