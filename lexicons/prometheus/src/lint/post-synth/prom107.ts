/**
 * PROM107: An alerting rule has no summary or description annotation
 *
 * A notification carries only the alert's labels unless an annotation says what is wrong.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { ruleFileDiagnostics } from "./prom-helpers";

export const prom107: PostSynthCheck = {
  id: "PROM107",
  description: "An alerting rule has no summary or description annotation",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return ruleFileDiagnostics(ctx, "PROM107");
  },
};
