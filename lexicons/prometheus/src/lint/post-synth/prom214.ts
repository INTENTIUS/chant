/**
 * PROM214: An alert template reads a label the expression aggregates away
 *
 * A $labels.x whose x the expression's by (...) leaves out, or its without
 * (...) names, renders empty. Labels the rule or its group set are left alone.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { ruleFileDiagnostics } from "./prom-helpers";

export const prom214: PostSynthCheck = {
  id: "PROM214",
  description: "An alert template reads a label the expression aggregates away",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return ruleFileDiagnostics(ctx, "PROM214");
  },
};
