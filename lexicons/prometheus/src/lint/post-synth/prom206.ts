/**
 * PROM206: A route or inhibit rule matcher does not parse
 *
 * Matchers are label, operator (=, !=, =~, !~) and value, e.g. severity="page".
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { alertmanagerDiagnostics } from "./prom-helpers";

export const prom206: PostSynthCheck = {
  id: "PROM206",
  description: "A route or inhibit rule matcher does not parse",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return alertmanagerDiagnostics(ctx, "PROM206");
  },
};
