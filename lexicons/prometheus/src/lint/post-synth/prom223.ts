/**
 * PROM223: repeat_interval is shorter than group_interval
 *
 * Alertmanager resends only when it flushes a group, every group_interval, so
 * a shorter repeat_interval never takes effect. Intervals are inherited down
 * the routing tree from Alertmanager's defaults.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { alertmanagerDiagnostics } from "./prom-helpers";

export const prom223: PostSynthCheck = {
  id: "PROM223",
  description: "repeat_interval is shorter than group_interval",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return alertmanagerDiagnostics(ctx, "PROM223");
  },
};
