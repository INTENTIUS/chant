/**
 * GRAF101: A panel, query or variable uses a datasource no Datasource in the build declares
 *
 * Grafana shows "datasource not found" on the panel. Typed references cannot go wrong this way, so it mostly catches a { type, uid } ref or a hand-edited dashboard. A panel with queries and no datasource at all is a warning: Grafana sends them to its default datasource. This check joins dashboards against the Datasource declarations of the same build root, so it goes silent across build roots (chant #1939): with no Datasource declared in the build it reports nothing, and a datasource declared in another build root looks undeclared. Keep datasources and the dashboards that use them in one build root.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { grafanaDiagnostics } from "./grafana-helpers";

export const graf101: PostSynthCheck = {
  id: "GRAF101",
  description: "A panel, query or variable uses a datasource no Datasource in the build declares",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return grafanaDiagnostics(ctx, "GRAF101");
  },
};
