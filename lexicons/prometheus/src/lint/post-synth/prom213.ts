/**
 * PROM213: An alert expression has no comparison
 *
 * Every series the expression returns is an alert, so an expression with no
 * comparison fires for all of them. absent(), absent_over_time() and unless
 * count as a condition; a comparison with bool does not. An expression that
 * reads no series (vector(1), a dead man's switch) is left alone.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { ruleFileDiagnostics } from "./prom-helpers";

export const prom213: PostSynthCheck = {
  id: "PROM213",
  description: "An alert expression has no comparison",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return ruleFileDiagnostics(ctx, "PROM213");
  },
};
