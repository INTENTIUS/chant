/**
 * PROM219: An alerting rule sets the alertname label
 *
 * Prometheus sets alertname to the rule's name after applying the rule's
 * labels, so the value is overwritten.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { ruleFileDiagnostics } from "./prom-helpers";

export const prom219: PostSynthCheck = {
  id: "PROM219",
  description: "An alerting rule sets the alertname label",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return ruleFileDiagnostics(ctx, "PROM219");
  },
};
