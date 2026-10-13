/**
 * PROM203: Two receivers or two time intervals share a name
 *
 * Alertmanager refuses a config with repeated receiver or time interval names.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { alertmanagerDiagnostics } from "./prom-helpers";

export const prom203: PostSynthCheck = {
  id: "PROM203",
  description: "Two receivers or two time intervals share a name",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return alertmanagerDiagnostics(ctx, "PROM203");
  },
};
