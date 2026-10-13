/**
 * PROM102: Two rules share a name and label set
 *
 * Two recording rules (or two alerts) with the same name and labels produce the same series and overwrite each other. This follows promtool's duplicate-rules lint: alerts that share a name and differ by a label, such as severity, are fine.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { ruleFileDiagnostics } from "./prom-helpers";

export const prom102: PostSynthCheck = {
  id: "PROM102",
  description: "Two rules share a name and label set",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return ruleFileDiagnostics(ctx, "PROM102");
  },
};
