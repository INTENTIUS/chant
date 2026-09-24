/**
 * OTEL106: A pipeline id or component reference is not valid collector syntax
 *
 * A pipeline id is a signal (traces, metrics, logs) optionally followed by /name, and every reference is type or type/name. Anything else is a config error at collector start.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { configDiagnostics } from "./otel-helpers";

export const otel106: PostSynthCheck = {
  id: "OTEL106",
  description: "A pipeline id or component reference is not valid collector syntax",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return configDiagnostics(ctx, "OTEL106");
  },
};
