/**
 * PROM208: An Alertmanager duration is not a duration
 *
 * group_wait, group_interval, repeat_interval, resolve_timeout and webhook timeout take durations such as 30s or 4h.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { alertmanagerDiagnostics } from "./prom-helpers";

export const prom208: PostSynthCheck = {
  id: "PROM208",
  description: "An Alertmanager duration is not a duration",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return alertmanagerDiagnostics(ctx, "PROM208");
  },
};
