/**
 * OTEL103: A declared component is never used
 *
 * A receiver, processor or exporter no pipeline lists, or an extension missing from service.extensions, is ignored by the collector. Usually it means a pipeline was meant to list it. A warning, since the config still runs.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { configDiagnostics } from "./otel-helpers";

export const otel103: PostSynthCheck = {
  id: "OTEL103",
  description: "A declared component is never used",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return configDiagnostics(ctx, "OTEL103");
  },
};
