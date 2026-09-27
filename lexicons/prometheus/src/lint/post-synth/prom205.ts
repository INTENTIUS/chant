/**
 * PROM205: The root route is missing, has no receiver, or has matchers
 *
 * The root route is the default for every alert: it must exist, name a receiver and match everything.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { alertmanagerDiagnostics } from "./prom-helpers";

export const prom205: PostSynthCheck = {
  id: "PROM205",
  description: "The root route is missing, has no receiver, or has matchers",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return alertmanagerDiagnostics(ctx, "PROM205");
  },
};
