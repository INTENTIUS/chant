/**
 * PROM106: An alerting rule has no severity label
 *
 * Alertmanager routes on labels, and severity is the one every route in this lexicon's examples and checks keys on. Without it the alert can only be routed by name.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { ruleFileDiagnostics } from "./prom-helpers";

export const prom106: PostSynthCheck = {
  id: "PROM106",
  description: "An alerting rule has no severity label",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return ruleFileDiagnostics(ctx, "PROM106");
  },
};
