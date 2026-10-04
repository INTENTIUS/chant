/**
 * PROM211: An alerting rule has no for, or for: 0s
 *
 * The alert fires on the first evaluation that matches, so one bad scrape
 * pages. Left alone when the expression reads no series (vector(1), a dead
 * man's switch) or already spans a window: every selector read through a
 * *_over_time function, or two conditions joined by and (the multi-window
 * burn-rate form, where the short window does what for would).
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { ruleFileDiagnostics } from "./prom-helpers";

export const prom211: PostSynthCheck = {
  id: "PROM211",
  description: "An alerting rule has no for, or for: 0s",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return ruleFileDiagnostics(ctx, "PROM211");
  },
};
