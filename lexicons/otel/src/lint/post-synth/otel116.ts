/**
 * OTEL116: A connector splits metrics by a high-cardinality GenAI attribute
 *
 * `gen_ai.conversation.id`, `gen_ai.response.id`, `gen_ai.tool.call.id`, `session.id`, `user.id`, `enduser.id` and the other keys in `GENAI_HIGH_CARDINALITY_ATTRIBUTES` take a new value per response, conversation or user, and the content keys (`gen_ai.input.messages` and the rest of `GENAI_CONTENT_ATTRIBUTES`) are unbounded. Used as a metric attribute in `spanmetrics` or `servicegraph` dimensions, `sum` or `count` attributes, or `signaltometrics` attributes or `include_resource_attributes`, each value starts new time series. The collector accepts such a config without a warning.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { configDiagnostics } from "./otel-helpers";

export const otel116: PostSynthCheck = {
  id: "OTEL116",
  description: "A connector splits metrics by a high-cardinality GenAI attribute",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return configDiagnostics(ctx, "OTEL116");
  },
};
