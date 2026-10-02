/**
 * PROM204: A route names a time interval that is not declared
 *
 * mute_time_intervals and active_time_intervals must name entries under time_intervals.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { alertmanagerDiagnostics } from "./prom-helpers";

export const prom204: PostSynthCheck = {
  id: "PROM204",
  description: "A route names a time interval that is not declared",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return alertmanagerDiagnostics(ctx, "PROM204");
  },
};
