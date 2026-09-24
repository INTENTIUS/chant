/**
 * OTEL109: A custom component has no schema pin
 *
 * defineComponent requires a pin naming the source and version its config type follows, so a reader can tell which schema the component was checked against. This check fails a build whose custom component lost its pin, for instance through an untyped call.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { entityDiagnostics } from "./otel-helpers";

export const otel109: PostSynthCheck = {
  id: "OTEL109",
  description: "A custom component has no schema pin",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return entityDiagnostics(ctx, "OTEL109");
  },
};
