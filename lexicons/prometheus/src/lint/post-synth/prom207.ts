/**
 * PROM207: A receiver is declared but no route sends to it
 *
 * An unused receiver usually means a route names the wrong one.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { alertmanagerDiagnostics } from "./prom-helpers";

export const prom207: PostSynthCheck = {
  id: "PROM207",
  description: "A receiver is declared but no route sends to it",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return alertmanagerDiagnostics(ctx, "PROM207");
  },
};
