/**
 * GRAF117: A query sent to Tempo is not valid TraceQL
 *
 * Each panel query whose datasource resolves to a tempo datasource and whose queryType is traceql (or unset, when the query is not a trace id) is parsed with the grammar behind Grafana's Tempo query editor (@grafana/lezer-traceql), after its template variables are replaced with placeholders the way GRAF108 replaces them. A parse error at a template variable is not reported. It is a warning: Grafana's TraceQL grammar trails Tempo's own parser (query hints such as `with (sample=true)` do not parse yet).
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { grafanaDiagnostics } from "./grafana-helpers";

export const graf117: PostSynthCheck = {
  id: "GRAF117",
  description: "A query sent to Tempo is not valid TraceQL",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return grafanaDiagnostics(ctx, "GRAF117");
  },
};
