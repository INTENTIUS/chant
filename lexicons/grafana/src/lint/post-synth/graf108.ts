/**
 * GRAF108: A query sent to Prometheus is not valid PromQL
 *
 * Each panel query, query variable and alert rule query whose datasource resolves to a prometheus datasource is parsed with the prometheus lexicon's checkPromql (@prometheus-io/lezer-promql), after its template variables ($var, ${var}, [[var]], $__interval, $__rate_interval, $__range and the other $__ macros) are replaced with placeholders that parse where they stand. A query whose datasource can't be told is not parsed; an alert rule query is parsed when its datasourceUid is a declared prometheus datasource or its model says `datasource.type: prometheus`. It is a syntax check: an unbalanced bracket or a bad duration fails, rate over an instant vector does not.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { grafanaDiagnostics } from "./grafana-helpers";

export const graf108: PostSynthCheck = {
  id: "GRAF108",
  description: "A query sent to Prometheus is not valid PromQL",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return grafanaDiagnostics(ctx, "GRAF108");
  },
};
