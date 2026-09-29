/**
 * GRAF102: A query is sent to a datasource of another plugin type
 *
 * A PromQL query sent to Tempo fails at query time. The typed classes prevent this at compile time; the check catches refs, datasource variables of the wrong plugin type and hand-edited dashboards. Like GRAF101 it joins against the Datasource and ExternalDatasource declarations of the same build root (chant #1939).
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { grafanaDiagnostics } from "./grafana-helpers";

export const graf102: PostSynthCheck = {
  id: "GRAF102",
  description: "A query is sent to a datasource of another plugin type",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return grafanaDiagnostics(ctx, "GRAF102");
  },
};
