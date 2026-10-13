/**
 * PROM103: A rule or group duration is not a Prometheus duration
 *
 * for, keep_firing_for, interval and query_offset take durations such as 30s, 5m or 1h30m. Prometheus refuses the rule file otherwise.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { ruleFileDiagnostics } from "./prom-helpers";

export const prom103: PostSynthCheck = {
  id: "PROM103",
  description: "A rule or group duration is not a Prometheus duration",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return ruleFileDiagnostics(ctx, "PROM103");
  },
};
