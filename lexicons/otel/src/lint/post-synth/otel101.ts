/**
 * OTEL101: A pipeline uses a receiver, processor or exporter that is not declared
 *
 * The collector refuses to start on this. Typed entity references cannot go wrong this way, so it mostly catches id strings (`"otlp/backend"`) and hand-edited or parsed configs. A connector id is accepted in receivers and exporters, but a connector counts as used only when one pipeline lists it as an exporter and another lists it as a receiver; listed on one side only, it fails this check.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { configDiagnostics } from "./otel-helpers";

export const otel101: PostSynthCheck = {
  id: "OTEL101",
  description: "A pipeline uses a receiver, processor or exporter that is not declared",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return configDiagnostics(ctx, "OTEL101");
  },
};
