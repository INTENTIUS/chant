/**
 * PROM101: Two rule groups in one rule file share a name
 *
 * Prometheus refuses to load a rule file whose group names repeat.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { ruleFileDiagnostics } from "./prom-helpers";

export const prom101: PostSynthCheck = {
  id: "PROM101",
  description: "Two rule groups in one rule file share a name",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return ruleFileDiagnostics(ctx, "PROM101");
  },
};
