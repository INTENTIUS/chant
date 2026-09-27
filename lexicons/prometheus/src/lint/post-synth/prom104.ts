/**
 * PROM104: A rule expression is not valid PromQL
 *
 * Every expr is parsed with the PromQL grammar the Prometheus project publishes. A syntax error fails the rule file at load time.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { ruleFileDiagnostics } from "./prom-helpers";

export const prom104: PostSynthCheck = {
  id: "PROM104",
  description: "A rule expression is not valid PromQL",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return ruleFileDiagnostics(ctx, "PROM104");
  },
};
