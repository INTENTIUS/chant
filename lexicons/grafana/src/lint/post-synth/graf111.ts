/**
 * GRAF111: An alert rule's condition, expression inputs or refIds do not fit together
 *
 * Each alert rule's condition, each server-side expression's inputs (a reduce, threshold or resample `expression`, the `$A` references of a math expression, a classic condition's query) and a recording rule's record.from must name a refId of the same rule; refIds must be unique, and a rule needs a condition unless it records. Each expression model is also validated against the pinned `expr` schema (a missing reducer, an unknown evaluator type). Grafana refuses such a rule, and a refused rule stops it provisioning every alerting file at startup.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { grafanaDiagnostics } from "./grafana-helpers";

export const graf111: PostSynthCheck = {
  id: "GRAF111",
  description: "An alert rule's condition, expression inputs or refIds do not fit together",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return grafanaDiagnostics(ctx, "GRAF111");
  },
};
