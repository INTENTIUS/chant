/**
 * PROM212: An alerting rule has no runbook_url annotation (opt-in)
 *
 * Off unless enabled: the lint preset all, or a lint.rules entry for PROM212,
 * turns it on. See validateRunbookUrls.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { runbookDiagnostics } from "./prom-helpers";

export const prom212: PostSynthCheck = {
  id: "PROM212",
  description: "An alerting rule has no runbook_url annotation (opt-in)",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return runbookDiagnostics(ctx);
  },
};
