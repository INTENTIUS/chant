/**
 * PROM201: A route sends to a receiver that is not declared
 *
 * Alertmanager refuses a config whose routes name an undefined receiver.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { alertmanagerDiagnostics } from "./prom-helpers";

export const prom201: PostSynthCheck = {
  id: "PROM201",
  description: "A route sends to a receiver that is not declared",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return alertmanagerDiagnostics(ctx, "PROM201");
  },
};
