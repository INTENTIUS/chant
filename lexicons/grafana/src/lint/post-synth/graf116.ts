/**
 * GRAF116: A query sent to Loki is not valid LogQL
 *
 * Each panel query, annotation query, query variable stream selector and alert rule query whose datasource resolves to a loki datasource is parsed with the grammar behind Grafana's Loki query editor (@grafana/lezer-logql), after its template variables are replaced with placeholders the way GRAF108 replaces them. A parse error at a template variable is not reported, since the variable's value decides. A query whose datasource can't be told is not parsed.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { grafanaDiagnostics } from "./grafana-helpers";

export const graf116: PostSynthCheck = {
  id: "GRAF116",
  description: "A query sent to Loki is not valid LogQL",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return grafanaDiagnostics(ctx, "GRAF116");
  },
};
