/**
 * GRAF101: A panel, query or variable uses a datasource no Datasource or ExternalDatasource in the build declares
 *
 * Grafana shows "datasource not found" on the panel. Typed references cannot go wrong this way, so it mostly catches a { type, uid } ref or a hand-edited dashboard. A datasource variable whose plugin type no declared datasource has is an error too. A panel with queries and no datasource at all is a warning: Grafana sends them to its default datasource. This check joins dashboards against the datasources of the same build root (chant #1939): declare one that exists in Grafana but is provisioned elsewhere with ExternalDatasource, which the check counts and the build never provisions. A build that declares no datasource at all gets one warning per dashboard that references any, since nothing can be checked.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { grafanaDiagnostics } from "./grafana-helpers";

export const graf101: PostSynthCheck = {
  id: "GRAF101",
  description: "A panel, query or variable uses a datasource no Datasource or ExternalDatasource in the build declares",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return grafanaDiagnostics(ctx, "GRAF101");
  },
};
