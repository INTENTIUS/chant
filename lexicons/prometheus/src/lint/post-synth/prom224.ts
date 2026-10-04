/**
 * PROM224: An inhibit rule matches one alert as source and target, with no equal
 *
 * With no equal, any alert matching the source mutes every alert matching the
 * target. When one alert can match both, alerts of that kind mute each other.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { alertmanagerDiagnostics } from "./prom-helpers";

export const prom224: PostSynthCheck = {
  id: "PROM224",
  description: "An inhibit rule matches one alert as source and target, with no equal",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return alertmanagerDiagnostics(ctx, "PROM224");
  },
};
